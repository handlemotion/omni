import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";
import type { CookieJar } from "./support.ts";

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);
afterAll(() => stack?.stop());

async function calendar(jar: CookieJar, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/calendar${path}`, stack.worker.url), {
    method,
    headers: { cookie: jar.header, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

const titles = (body: { tasks: { title: string }[] }) => body.tasks.map((task) => task.title);

async function team() {
  const org = await stack.company(`activity-${crypto.randomUUID().slice(0, 8)}`);
  const ana = await stack.member(org.id);
  const bea = await stack.member(org.id);
  const dealId = (await stack.api(ana.jar, "POST", "/deals", { name: "Website" })).body.deal.id;
  return { org, ana, bea, dealId };
}

test("a cancelled task leaves the open list and counts; done and reopen keep status and completion in step", async () => {
  const { ana, dealId } = await team();
  const made = await stack.api(ana.jar, "POST", "/tasks", {
    title: "Draft",
    dealId,
    priority: "high",
  });
  expect(made.status).toBe(201);
  expect(made.body.task).toMatchObject({ status: "todo", priority: "high", completedAt: null });
  const id = made.body.task.id;

  const started = await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { status: "in_progress" });
  expect(started.body.task).toMatchObject({ status: "in_progress", completedAt: null });
  expect(titles((await stack.api(ana.jar, "GET", "/tasks")).body)).toEqual(["Draft"]);

  const cancelled = await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { status: "cancelled" });
  expect(cancelled.body.task.status).toBe("cancelled");
  expect(cancelled.body.task.completedAt).not.toBeNull();
  expect(titles((await stack.api(ana.jar, "GET", "/tasks")).body)).toEqual([]);
  expect(titles((await stack.api(ana.jar, "GET", "/tasks?status=done")).body)).toEqual(["Draft"]);
  expect((await stack.api(ana.jar, "GET", "/tasks/counts")).body.counts.open).toBe(0);

  const reopened = await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { done: false });
  expect(reopened.body.task).toMatchObject({ status: "todo", completedAt: null });
  const done = await calendar(ana.jar, "PATCH", `/tasks/${id}`, { done: true });
  expect(done.body.task.status).toBe("done");
  expect(done.body.task.completedByMemberId).toBe(ana.id);
});

test("a status an older Worker left behind reads from completed_at", async () => {
  const { ana, dealId } = await team();
  const id = (await stack.api(ana.jar, "POST", "/tasks", { title: "Old", dealId })).body.task.id;
  await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { status: "done" });
  await stack.db
    .update(schema.calendarTasks)
    .set({ completedAt: null, completedByMemberId: null })
    .where(eq(schema.calendarTasks.id, id));
  expect((await stack.api(ana.jar, "GET", `/tasks/${id}`)).body.task.status).toBe("todo");
  await stack.db
    .update(schema.calendarTasks)
    .set({ status: null, completedAt: new Date() })
    .where(eq(schema.calendarTasks.id, id));
  expect((await stack.api(ana.jar, "GET", `/tasks/${id}`)).body.task.status).toBe("done");
});

test("activity lists who changed what, oldest first, with the record's name, and not edits to the title or body", async () => {
  const { ana, bea, dealId } = await team();
  const id = (await stack.api(ana.jar, "POST", "/tasks", { title: "Ship", dealId })).body.task.id;
  expect((await stack.api(ana.jar, "GET", `/tasks/${id}/activity`)).body.items).toEqual([]);

  const due = "2026-12-01T22:59:59.000Z";
  await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { status: "in_progress", priority: "urgent" });
  await stack.api(bea.jar, "PATCH", `/tasks/${id}`, { assigneeMemberId: bea.id, dueAt: due });
  await stack.api(bea.jar, "PATCH", `/tasks/${id}`, { title: "Ship it", body: "Soon" });
  await stack.api(ana.jar, "PATCH", `/tasks/${id}`, { dealId: null });

  const items = (await calendar(bea.jar, "GET", `/tasks/${id}/activity`)).body.items;
  const shape = items.map(({ id: _id, at: _at, ...item }: { id: string; at: string }) => item);
  expect(shape).toEqual([
    { kind: "status", from: "todo", to: "in_progress", actorMemberId: ana.id },
    { kind: "priority", from: null, to: "urgent", actorMemberId: ana.id },
    { kind: "assignee", from: ana.id, to: bea.id, actorMemberId: bea.id },
    { kind: "due", from: null, to: due, actorMemberId: bea.id },
    {
      kind: "record",
      from: { kind: "deal", id: dealId, name: "Website" },
      to: null,
      actorMemberId: ana.id,
    },
  ]);
});

test("another workspace, and a teammate on a private task, cannot read its activity", async () => {
  const { ana, bea, dealId } = await team();
  const outsider = await stack.member((await stack.company("elsewhere")).id);
  const linked = (await stack.api(ana.jar, "POST", "/tasks", { title: "Linked", dealId })).body.task
    .id;
  const own = (await calendar(ana.jar, "POST", "/tasks", { title: "Dentist" })).body.task.id;
  await calendar(ana.jar, "PATCH", `/tasks/${own}`, { priority: "low" });

  for (const [jar, id] of [
    [outsider.jar, linked],
    [bea.jar, own],
  ] as const) {
    expect((await stack.api(jar, "GET", `/tasks/${id}/activity`)).status).toBe(404);
    expect((await calendar(jar, "GET", `/tasks/${id}/activity`)).status).toBe(404);
  }
  const mine = await calendar(ana.jar, "GET", `/tasks/${own}/activity`);
  expect(mine.body.items).toMatchObject([{ kind: "priority", from: null, to: "low" }]);
  const rows = await stack.db
    .select()
    .from(schema.calendarTaskActivity)
    .where(eq(schema.calendarTaskActivity.taskId, own));
  expect(rows.map((row) => row.actorMemberId)).toEqual([ana.id]);
});
