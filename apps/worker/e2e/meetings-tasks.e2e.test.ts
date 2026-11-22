/* oxlint-disable typescript/no-explicit-any -- test reads of JSON answers */
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startMeetingsStack, type MeetingsStack } from "./meetings-support.ts";
import type { Person } from "./storage-support.ts";

let m: MeetingsStack;
beforeAll(async () => {
  m = await startMeetingsStack();
}, 120_000);
afterAll(() => m?.stop());

async function calendarTasks(person: Person) {
  const response = await fetch(new URL("/api/calendar/tasks", m.stack.worker.url), {
    headers: { cookie: person.jar.header },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { tasks: any[] }).tasks;
}

test("an accepted task becomes one task in the accepter's calendar, even accepted twice at once", async () => {
  const org = await m.stack.company(`meetings-${randomUUID().slice(0, 8)}`);
  const dana = await m.stack.member(org.id);
  const ben = await m.stack.member(org.id);
  const { meetingId } = await m.record(dana, {
    title: "Entregas sitio web",
    attendees: [{ address: "marta@client.test", name: "Marta Gil" }, { address: ben.email }],
  });
  const { actions } = (await m.api(dana, "GET", `/${meetingId}`)).body;
  const task = actions.find((a: any) => a.kind === "task");
  const email = actions.find((a: any) => a.kind === "email");

  expect((await m.api(ben, "POST", `/actions/${task.id}/accept`)).status).toBe(403);
  const both = await Promise.all([
    m.api(dana, "POST", `/actions/${task.id}/accept`),
    m.api(dana, "POST", `/actions/${task.id}/accept`),
  ]);
  expect(both.map((r) => r.status).toSorted()).toEqual([200, 409]);
  const made = await m.stack.db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.orgId, org.id));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({
    title: task.payload.title,
    ownerMemberId: dana.id,
    assigneeMemberId: dana.id,
    recordKind: null,
  });

  const listed = await calendarTasks(dana);
  expect(listed.map((t) => t.id)).toEqual([made[0]!.id]);
  expect(listed[0].body).toContain("From the meeting Entregas sitio web");
  expect(await calendarTasks(ben)).toEqual([]);

  const after = (await m.api(dana, "GET", `/${meetingId}`)).body.actions;
  expect(after.find((a: any) => a.id === task.id)).toMatchObject({
    state: "done",
    taskId: made[0]!.id,
  });

  const dismissed = await m.api(dana, "POST", `/actions/${email.id}/dismiss`);
  expect(dismissed.body.action).toMatchObject({ state: "dismissed" });
  expect(
    await m.stack.db
      .select()
      .from(schema.calendarTasks)
      .where(eq(schema.calendarTasks.orgId, org.id)),
  ).toHaveLength(1);
});
