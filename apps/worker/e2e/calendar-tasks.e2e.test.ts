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
  const org = await stack.company(`tasks-${crypto.randomUUID().slice(0, 8)}`);
  const owner = await stack.member(org.id, "owner");
  const admin = await stack.member(org.id, "admin");
  const ben = await stack.member(org.id);
  return { org, owner, admin, ben };
}

test("a private task is its owner's alone: no admin or owner sees it in the calendar or the CRM", async () => {
  const { owner, admin, ben } = await team();
  const made = await calendar(ben.jar, "POST", "/tasks", { title: "Dentist" });
  expect(made.status).toBe(201);
  expect(made.body.task).toMatchObject({ record: null, ownerMemberId: ben.id });
  const id = made.body.task.id;
  expect(titles((await calendar(ben.jar, "GET", "/tasks")).body)).toEqual(["Dentist"]);

  for (const other of [owner, admin]) {
    expect(titles((await calendar(other.jar, "GET", "/tasks")).body)).toEqual([]);
    expect((await calendar(other.jar, "GET", `/tasks/${id}`)).status).toBe(404);
    expect((await calendar(other.jar, "PATCH", `/tasks/${id}`, { done: true })).status).toBe(404);
    expect((await calendar(other.jar, "DELETE", `/tasks/${id}`)).status).toBe(404);
    expect((await stack.api(other.jar, "GET", `/tasks/${id}`)).status).toBe(404);
    expect((await stack.api(other.jar, "PATCH", `/tasks/${id}`, { done: true })).status).toBe(404);
  }
  for (const anyone of [owner, admin, ben]) {
    expect(titles((await stack.api(anyone.jar, "GET", "/tasks")).body)).toEqual([]);
    expect((await stack.api(anyone.jar, "GET", "/tasks/counts")).body.counts.open).toBe(0);
  }
  expect((await stack.api(ben.jar, "GET", `/tasks/${id}`)).status).toBe(404);
  const [row] = await stack.db.select().from(schema.crmTasks).where(eq(schema.crmTasks.id, id));
  expect(row).toBeUndefined();
});

test("a linked task shows to whoever can open its record, not to a freelancer off it, and hides again once taken off", async () => {
  const { org, owner, ben } = await team();
  const cy = await stack.member(org.id);
  const fran = await stack.member(org.id, "freelancer");
  const deal = (await stack.api(owner.jar, "POST", "/deals", { name: "Website" })).body.deal.id;

  const made = await calendar(ben.jar, "POST", "/tasks", { title: "Send the quote" });
  const id = made.body.task.id;
  const linked = await stack.api(ben.jar, "PATCH", `/tasks/${id}`, { dealId: deal });
  expect(linked.status).toBe(200);
  expect(linked.body.task).toMatchObject({ dealId: deal, recordName: "Website" });

  expect(titles((await stack.api(cy.jar, "GET", "/tasks")).body)).toEqual(["Send the quote"]);
  expect((await stack.api(cy.jar, "GET", `/tasks/${id}`)).status).toBe(200);
  expect(titles((await stack.api(fran.jar, "GET", "/tasks")).body)).toEqual([]);
  expect((await stack.api(fran.jar, "GET", `/tasks/${id}`)).status).toBe(404);
  expect(titles((await calendar(cy.jar, "GET", "/tasks")).body)).toEqual([]);

  const handed = await stack.api(owner.jar, "PATCH", `/tasks/${id}`, { assigneeMemberId: cy.id });
  expect(handed.status).toBe(200);
  expect(titles((await calendar(cy.jar, "GET", "/tasks")).body)).toEqual(["Send the quote"]);
  expect(titles((await calendar(ben.jar, "GET", "/tasks")).body)).toEqual(["Send the quote"]);
  const renamed = await calendar(cy.jar, "PATCH", `/tasks/${id}`, {
    title: "Send the quote today",
  });
  expect(renamed.status).toBe(200);
  const [mirrored] = await stack.db
    .select()
    .from(schema.crmTasks)
    .where(eq(schema.crmTasks.id, id));
  expect(mirrored).toMatchObject({
    title: "Send the quote today",
    dealId: deal,
    assigneeMemberId: cy.id,
  });

  const off = await stack.api(owner.jar, "PATCH", `/tasks/${id}`, { dealId: null });
  expect(off.body.task).toMatchObject({ dealId: null, ownerMemberId: cy.id });
  expect(titles((await stack.api(owner.jar, "GET", "/tasks")).body)).toEqual([]);
  expect((await stack.api(owner.jar, "GET", `/tasks/${id}`)).status).toBe(404);
  expect(titles((await calendar(ben.jar, "GET", "/tasks")).body)).toEqual([]);
  expect(titles((await calendar(cy.jar, "GET", "/tasks")).body)).toEqual(["Send the quote today"]);
});

test("a private task cannot be assigned; a linked one only to someone who can open its record", async () => {
  const { org, owner, ben } = await team();
  const fran = await stack.member(org.id, "freelancer");
  const website = (await stack.api(owner.jar, "POST", "/deals", { name: "Website" })).body.deal.id;
  const app = (await stack.api(owner.jar, "POST", "/deals", { name: "App" })).body.deal.id;
  const access = await stack.api(
    owner.jar,
    "PUT",
    `/deals/${website}/access/${encodeURIComponent(fran.email)}`,
    { scope: "freelancer" },
  );
  expect(access.status).toBe(201);

  const mine = (await calendar(ben.jar, "POST", "/tasks", { title: "Mine" })).body.task.id;
  const assign = await stack.api(ben.jar, "PATCH", `/tasks/${mine}`, {
    assigneeMemberId: owner.id,
  });
  expect(assign.status).toBe(400);
  expect(assign.body.param).toBe("assigneeMemberId");
  const handed = await stack.api(ben.jar, "POST", "/tasks", {
    title: "For the owner",
    assigneeMemberId: owner.id,
  });
  expect(handed.status).toBe(400);
  expect(titles((await calendar(owner.jar, "GET", "/tasks")).body)).toEqual([]);

  const onApp = await stack.api(owner.jar, "POST", "/tasks", {
    title: "App task",
    dealId: app,
    assigneeMemberId: fran.id,
  });
  expect(onApp.status).toBe(400);
  expect(onApp.body.param).toBe("assigneeMemberId");
  const onWebsite = await stack.api(owner.jar, "POST", "/tasks", {
    title: "Website task",
    dealId: website,
    assigneeMemberId: fran.id,
  });
  expect(onWebsite.status).toBe(201);
  const moved = await stack.api(owner.jar, "PATCH", `/tasks/${onWebsite.body.task.id}`, {
    dealId: app,
  });
  expect(moved.status).toBe(400);
  expect(titles((await calendar(fran.jar, "GET", "/tasks")).body)).toEqual(["Website task"]);
});
