import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const titles = (body: { tasks: { title: string }[] }) => body.tasks.map((task) => task.title);

test("open tasks page soonest due first, undated last, with no row lost or repeated", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const plan = [
    ["undated a", null],
    ["in 3h", hours(3)],
    ["overdue 2h", hours(-2)],
    ["undated b", null],
    ["in 1h", hours(1)],
  ] as const;
  for (const [title, dueAt] of plan) {
    expect((await stack.api(ana.jar, "POST", "/tasks", { title, dueAt })).status).toBe(201);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/tasks?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
    const page = await stack.api(ana.jar, "GET", query);
    expect(page.status).toBe(200);
    seen.push(...titles(page.body));
    cursor = page.body.nextCursor;
  } while (cursor);

  expect(seen.slice(0, 3)).toEqual(["overdue 2h", "in 1h", "in 3h"]);
  expect(seen.slice(3).toSorted()).toEqual(["undated a", "undated b"]);
});

test("filters by assignee, due and done; completing twice keeps the first completion", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);

  const mine = await stack.api(ana.jar, "POST", "/tasks", { title: "Mine", dueAt: hours(-1) });
  expect(mine.body.task.assigneeMemberId).toBe(ana.id);
  await stack.api(ana.jar, "POST", "/tasks", { title: "Bea's", assigneeMemberId: bea.id });
  await stack.api(ana.jar, "POST", "/tasks", { title: "Nobody's", assigneeMemberId: null });

  expect(titles((await stack.api(ana.jar, "GET", "/tasks?assignee=me")).body)).toEqual(["Mine"]);
  expect(titles((await stack.api(bea.jar, "GET", "/tasks?assignee=me")).body)).toEqual(["Bea's"]);
  expect(titles((await stack.api(ana.jar, "GET", `/tasks?assignee=${bea.id}`)).body)).toEqual([
    "Bea's",
  ]);
  expect(titles((await stack.api(ana.jar, "GET", "/tasks?assignee=none")).body)).toEqual([
    "Nobody's",
  ]);
  expect(titles((await stack.api(ana.jar, "GET", "/tasks?due=overdue")).body)).toEqual(["Mine"]);
  expect((await stack.api(ana.jar, "GET", "/tasks/counts")).body.counts).toEqual({
    mine: 1,
    mineOverdue: 1,
    open: 3,
    overdue: 1,
  });

  const done = await stack.api(bea.jar, "PATCH", `/tasks/${mine.body.task.id}`, { done: true });
  expect(done.status).toBe(200);
  expect(done.body.task.completedByMemberId).toBe(bea.id);
  const again = await stack.api(ana.jar, "PATCH", `/tasks/${mine.body.task.id}`, { done: true });
  expect(again.body.task.completedAt).toBe(done.body.task.completedAt);
  expect(again.body.task.completedByMemberId).toBe(bea.id);

  expect(titles((await stack.api(ana.jar, "GET", "/tasks?assignee=me")).body)).toEqual([]);
  expect(titles((await stack.api(ana.jar, "GET", "/tasks?status=done")).body)).toEqual(["Mine"]);
  expect((await stack.api(ana.jar, "GET", "/tasks/counts")).body.counts.mineOverdue).toBe(0);

  const reopened = await stack.api(ana.jar, "PATCH", `/tasks/${mine.body.task.id}`, {
    done: false,
  });
  expect(reopened.body.task).toMatchObject({ completedAt: null, completedByMemberId: null });
  expect(titles((await stack.api(ana.jar, "GET", "/tasks?assignee=me")).body)).toEqual(["Mine"]);
});

test("a record lists its own tasks; deleting the record or the assignee is handled", async () => {
  const acme = await stack.company("acme");
  const owner = await stack.member(acme.id, "owner");
  const bea = await stack.member(acme.id);
  const deal = await stack.api(owner.jar, "POST", "/deals", { name: "Website" });
  const other = await stack.api(owner.jar, "POST", "/deals", { name: "App" });
  const dealId = deal.body.deal.id;

  const onDeal = await stack.api(owner.jar, "POST", "/tasks", {
    title: "Send proposal",
    dealId,
    assigneeMemberId: bea.id,
  });
  expect(onDeal.body.task).toMatchObject({ dealId, recordName: "Website" });
  await stack.api(owner.jar, "POST", "/tasks", { title: "Other", dealId: other.body.deal.id });
  await stack.api(owner.jar, "POST", "/tasks", { title: "Loose" });
  expect(titles((await stack.api(owner.jar, "GET", `/tasks?deal=${dealId}`)).body)).toEqual([
    "Send proposal",
  ]);

  const moved = await stack.api(owner.jar, "PATCH", `/tasks/${onDeal.body.task.id}`, {
    dealId: null,
  });
  expect(moved.body.task).toMatchObject({ dealId: null, recordName: null });
  await stack.api(owner.jar, "PATCH", `/tasks/${onDeal.body.task.id}`, { dealId });

  await stack.db.delete(schema.members).where(eq(schema.members.id, bea.id));
  const unassigned = await stack.api(owner.jar, "GET", `/tasks/${onDeal.body.task.id}`);
  expect(unassigned.body.task.assigneeMemberId).toBeNull();

  const gone = await stack.api(owner.jar, "DELETE", `/deals/${dealId}?forever=1`);
  expect(gone.status).toBe(204);
  expect((await stack.api(owner.jar, "GET", `/tasks/${onDeal.body.task.id}`)).status).toBe(404);
});

test("another workspace cannot read, change, assign into or link to a task", async () => {
  const acme = await stack.company("acme");
  const beta = await stack.company("beta");
  const ana = await stack.member(acme.id);
  const cid = await stack.member(beta.id);
  const theirDeal = await stack.api(cid.jar, "POST", "/deals", { name: "Theirs" });

  const task = await stack.api(ana.jar, "POST", "/tasks", { title: "Ours" });
  const id = task.body.task.id;
  expect((await stack.api(cid.jar, "GET", `/tasks/${id}`)).status).toBe(404);
  expect((await stack.api(cid.jar, "PATCH", `/tasks/${id}`, { done: true })).status).toBe(404);
  expect((await stack.api(cid.jar, "DELETE", `/tasks/${id}`)).status).toBe(404);
  expect(titles((await stack.api(cid.jar, "GET", "/tasks")).body)).toEqual([]);

  const assign = await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { assigneeMemberId: cid.id });
  expect(assign.status).toBe(400);
  expect(assign.body.param).toBe("assigneeMemberId");
  const link = await stack.api(ana.jar, "POST", "/tasks", {
    title: "Link",
    dealId: theirDeal.body.deal.id,
  });
  expect(link.status).toBe(404);
  const blank = await stack.api(ana.jar, "POST", "/tasks", { title: "   " });
  expect(blank.status).toBe(400);
});

test("a task write reaches a teammate's socket with its record", async () => {
  const acme = await stack.company("acme");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  const company = await stack.api(ana.jar, "POST", "/companies", { name: "Initech" });
  const socket = await stack.socket(bea.jar);

  const made = await stack.api(ana.jar, "POST", "/tasks", {
    title: "Call",
    companyId: company.body.company.id,
  });
  const taskEvent = await socket.waitFor((e) => e.type === "crm.changed" && e.kind === "task");
  expect(taskEvent.ids).toEqual([made.body.task.id]);
  const recordEvent = await socket.waitFor(
    (e) => e.type === "crm.changed" && e.kind === "company" && e.ids !== undefined,
  );
  expect(recordEvent.ids).toEqual([company.body.company.id]);
  socket.close();
});
