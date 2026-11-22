import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { copyTasksToCalendar } from "../src/crm.ts";
import { forMember } from "../src/for-member.ts";
import { releaseCalendarTasks } from "../src/calendar.ts";
import { ensurePersonalSpace } from "../src/personal-space.ts";
import { calendarTasks, crmTasks, members } from "../src/schema/index.ts";
import { createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const owner = await createMember(db, org.id, "owner");
  await setRole(db, owner.id, "owner");
  const ana = await createMember(db, org.id, "ana");
  const ben = await createMember(db, org.id, "ben");
  return { org, owner, ana, ben };
}

const calendarRow = async (id: string) =>
  (await db.select().from(calendarTasks).where(eq(calendarTasks.id, id)))[0];

const titles = (listed: { tasks: { title: string }[] }) => listed.tasks.map((t) => t.title);

test("a private task is its owner's alone: no teammate, owner or admin sees or changes it", async () => {
  const { owner, ana, ben } = await workspace("tasks-private");
  await setRole(db, ben.id, "admin");
  const mine = forMember(db, ana.id).calendar;
  const task = ok(await mine.createTask({ title: "Call the dentist" })).task;
  expect(task.record).toBeNull();
  expect([task.ownerMemberId, task.assigneeMemberId]).toEqual([ana.id, ana.id]);
  expect(titles(ok(await mine.tasks()))).toEqual(["Call the dentist"]);

  for (const other of [owner.id, ben.id]) {
    const cal = forMember(db, other).calendar;
    expect(titles(ok(await cal.tasks()))).toEqual([]);
    expect((await cal.task(task.id)).status).toBe("not_found");
    expect((await cal.updateTask(task.id, { title: "Mine now" })).status).toBe("not_found");
    expect((await cal.deleteTask(task.id)).status).toBe("not_found");
  }
  expect(ok(await mine.task(task.id)).task.title).toBe("Call the dentist");
});

test("a Personal space keeps its person's tasks, with no CRM to put them on", async () => {
  const person = await createPerson(db, `solo-${crypto.randomUUID()}@example.test`);
  const orgId = await ensurePersonalSpace(db, person.id);
  const [member] = await db.select().from(members).where(eq(members.organizationId, orgId));
  const cal = forMember(db, member!.id).calendar;
  const made = ok(await cal.createTask({ title: "Renew passport" })).task;
  const done = ok(await cal.updateTask(made.id, { done: true })).task;
  expect(done.completedAt).not.toBeNull();
  expect(titles(ok(await cal.tasks({ status: "done" })))).toEqual(["Renew passport"]);
});

test("a CRM task is written to the calendar too: linked stays the workspace's, unlinked goes to its assignee alone", async () => {
  const { ana, ben } = await workspace("tasks-dual");
  const crm = forMember(db, ana.id).crm;
  const person = ok(await crm.addPerson({ name: "Bea", address: "bea@dual.test" })).person;

  const linked = ok(
    await crm.createTask({
      title: "Send quote",
      record: { personId: person.id },
      assigneeMemberId: ben.id,
    }),
  ).task;
  const copy = (await calendarRow(linked.id))!;
  expect(copy).toMatchObject({
    title: "Send quote",
    ownerMemberId: ana.id,
    assigneeMemberId: ben.id,
    recordKind: "person",
    recordId: person.id,
  });
  const [original] = await db.select().from(crmTasks).where(eq(crmTasks.id, linked.id));
  expect(copy.updatedAt).toEqual(original!.updatedAt);
  expect(titles(ok(await forMember(db, ben.id).calendar.tasks()))).toEqual(["Send quote"]);

  const handed = ok(await crm.createTask({ title: "Book flights", assigneeMemberId: ben.id })).task;
  expect(await calendarRow(handed.id)).toMatchObject({
    ownerMemberId: ben.id,
    assigneeMemberId: ben.id,
    recordKind: null,
  });
  expect(titles(ok(await forMember(db, ana.id).calendar.tasks()))).toEqual(["Send quote"]);

  ok(await crm.updateTask(linked.id, { record: null, done: true }));
  expect(await calendarRow(linked.id)).toMatchObject({
    ownerMemberId: ben.id,
    assigneeMemberId: ben.id,
    recordKind: null,
  });
  ok(await crm.deleteTask(handed.id));
  expect(await calendarRow(handed.id)).toBeUndefined();
});

test("deleting a record deletes the calendar's tasks on it", async () => {
  const { owner } = await workspace("tasks-record-gone");
  const crm = forMember(db, owner.id).crm;
  const person = ok(await crm.addPerson({ name: "Cy", address: "cy@gone.test" })).person;
  const task = ok(
    await crm.createTask({ title: "Follow up", record: { personId: person.id } }),
  ).task;
  ok(await crm.deletePerson(person.id));
  expect(await calendarRow(task.id)).toBeUndefined();
});

test("a removed member's private tasks go with them; their linked ones stay, unassigned", async () => {
  const { org, ana, ben } = await workspace("tasks-leave");
  const crm = forMember(db, ana.id).crm;
  const person = ok(await crm.addPerson({ name: "Di", address: "di@leave.test" })).person;
  const linked = ok(
    await crm.createTask({
      title: "Renewal",
      record: { personId: person.id },
      assigneeMemberId: ana.id,
    }),
  ).task;
  const own = ok(await forMember(db, ana.id).calendar.createTask({ title: "Gym" })).task;

  await releaseCalendarTasks(db, { orgId: org.id, memberId: ana.id });
  await releaseCalendarTasks(db, { orgId: org.id, memberId: ana.id });
  await db.delete(members).where(eq(members.id, ana.id));

  expect(await calendarRow(own.id)).toBeUndefined();
  expect(await calendarRow(linked.id)).toMatchObject({
    ownerMemberId: null,
    assigneeMemberId: null,
    recordKind: "person",
  });
  expect(titles(ok(await forMember(db, ben.id).calendar.tasks()))).toEqual([]);
});

test("the copy job copies what the calendar lacks, twice to the same rows, and again once the CRM's row is newer", async () => {
  const { org, owner, ana, ben } = await workspace("tasks-copy");
  const person = ok(
    await forMember(db, ana.id).crm.addPerson({ name: "Ed", address: "ed@copy.test" }),
  ).person;
  const before = new Date("2026-01-05T10:00:00Z");
  const rows = await db
    .insert(crmTasks)
    .values([
      {
        orgId: org.id,
        title: "On Ed",
        personId: person.id,
        assigneeMemberId: ben.id,
        createdByMemberId: ana.id,
        updatedAt: before,
      },
      {
        orgId: org.id,
        title: "Handed to Ben",
        assigneeMemberId: ben.id,
        createdByMemberId: ana.id,
        updatedAt: before,
      },
      {
        orgId: org.id,
        title: "Ana's own",
        assigneeMemberId: null,
        createdByMemberId: ana.id,
        updatedAt: before,
      },
      { orgId: org.id, title: "Nobody's", updatedAt: before },
    ])
    .returning();
  const [onEd, handed, anas, nobodys] = rows;

  const first = await copyTasksToCalendar(db, 2);
  expect(first.copied).toBeGreaterThanOrEqual(4);
  const snapshot = await db.select().from(calendarTasks).where(eq(calendarTasks.orgId, org.id));
  expect((await copyTasksToCalendar(db, 2)).copied).toBe(0);
  expect(await db.select().from(calendarTasks).where(eq(calendarTasks.orgId, org.id))).toEqual(
    snapshot,
  );

  expect(await calendarRow(onEd!.id)).toMatchObject({
    ownerMemberId: ana.id,
    assigneeMemberId: ben.id,
    recordKind: "person",
  });
  expect(await calendarRow(handed!.id)).toMatchObject({
    ownerMemberId: ben.id,
    assigneeMemberId: ben.id,
    recordKind: null,
  });
  expect(await calendarRow(anas!.id)).toMatchObject({ ownerMemberId: ana.id, recordKind: null });
  expect(await calendarRow(nobodys!.id)).toMatchObject({
    ownerMemberId: owner.id,
    recordKind: null,
  });
  expect(titles(ok(await forMember(db, ana.id).calendar.tasks())).toSorted()).toEqual([
    "Ana's own",
    "On Ed",
  ]);

  await db
    .update(crmTasks)
    .set({ title: "On Ed, renamed", updatedAt: new Date("2026-01-06T10:00:00Z") })
    .where(eq(crmTasks.id, onEd!.id));
  expect((await copyTasksToCalendar(db)).copied).toBe(1);
  expect((await calendarRow(onEd!.id))!.title).toBe("On Ed, renamed");
});
