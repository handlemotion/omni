import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { forMember } from "../src/for-member.ts";
import { meetingsPipeline } from "../src/meetings.ts";
import { meetingsActions, members, users } from "../src/schema/index.ts";
import { createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function memberOf(orgId: string, address: string) {
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), name: address, email: address, emailVerified: true })
    .returning();
  const [member] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: user!.id,
      role: "member",
      createdAt: new Date(),
    })
    .returning();
  return { id: member!.id, address };
}

async function studio() {
  const t = randomUUID().slice(0, 8);
  const org = await createOrg(db, `meet-crm-${t}`);
  const dana = await memberOf(org.id, `dana-${t}@studio.test`);
  const ben = await memberOf(org.id, `ben-${t}@studio.test`);
  return { t, org, dana, ben };
}

async function recorded(memberId: string, title: string, attendees: string[], at: Date) {
  const { meetingId } = ok(
    await forMember(db, memberId).meetings.start({
      title,
      event: null,
      attendees: attendees.map((address) => ({ address, name: null })),
      ownDomains: ["studio.test"],
      consent: true,
    }),
  );
  await db.execute(
    sql`update meetings_meetings set started_at = ${at.toISOString()}::timestamptz where id = ${meetingId}`,
  );
  return meetingId;
}

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 10));

test("a deal shows the meetings put on it and those with its people or its company's domain, unless placed elsewhere or taken off, and never one its reader cannot open", async () => {
  const s = await studio();
  const deal = { kind: "deal" as const, id: randomUUID() };
  const other = { kind: "deal" as const, id: randomUUID() };
  const marta = `marta@acme-${s.t}.test`;
  const byPerson = await recorded(s.dana.id, "With Marta", [s.dana.address, marta], day(1));
  const byDomain = await recorded(s.dana.id, "With Acme", [`lee@ACME-${s.t}.test`], day(2));
  const putOn = await recorded(s.dana.id, "Internal prep", [s.ben.address], day(3));
  const elsewhere = await recorded(s.dana.id, "Other project", [marta], day(4));
  const takenOff = await recorded(s.dana.id, "Personal", [marta], day(5));
  const unrelated = await recorded(s.dana.id, "Someone else", ["x@else.test"], day(6));
  const notMine = await recorded(s.ben.id, "Ben alone", [marta], day(7));
  const dana = forMember(db, s.dana.id).meetings;
  ok(await dana.setRecord(putOn, deal));
  ok(await dana.setRecord(elsewhere, other));
  ok(await dana.setRecord(takenOff, null));

  const query = { record: deal, addresses: [marta.toUpperCase()], domains: [`acme-${s.t}.test`] };
  const tab = ok(await dana.on({ ...query, only: "unplaced" }));
  expect(tab.meetings.map((m) => m.title)).toEqual(["Internal prep", "With Acme", "With Marta"]);
  expect(tab.meetings.find((m) => m.id === putOn)).toMatchObject({ placed: true });
  expect(tab.meetings.find((m) => m.id === byPerson)).toMatchObject({ placed: false });

  const timeline = ok(await dana.on(query));
  expect(timeline.meetings.map((m) => m.id)).toEqual([
    takenOff,
    elsewhere,
    putOn,
    byDomain,
    byPerson,
  ]);
  expect(timeline.meetings.map((m) => m.id)).not.toContain(unrelated);
  expect(timeline.meetings.map((m) => m.id)).not.toContain(notMine);

  const firstPage = ok(await dana.on({ ...query, limit: 2 }));
  const last = firstPage.meetings.at(-1)!;
  const next = ok(await dana.on({ ...query, before: { startedAt: last.startedAt, id: last.id } }));
  expect([...firstPage.meetings, ...next.meetings].map((m) => m.id)).toEqual(
    timeline.meetings.map((m) => m.id),
  );

  const outsider = await createOrg(db, `meet-crm-out-${s.t}`);
  const eve = await memberOf(outsider.id, `eve-${s.t}@else.test`);
  expect(ok(await forMember(db, eve.id).meetings.on(query)).meetings).toEqual([]);
});

test("a meeting's record is changed only by its editors, and the deal's tab shows its summary and open actions", async () => {
  const s = await studio();
  const deal = { kind: "deal" as const, id: randomUUID() };
  const meetingId = await recorded(s.dana.id, "Kickoff", [s.dana.address, s.ben.address], day(1));
  expect(await forMember(db, s.ben.id).meetings.setRecord(meetingId, deal)).toEqual({
    status: "forbidden",
  });

  const pipeline = meetingsPipeline(db);
  await pipeline.advance(meetingId, ["recording"], "writing");
  await pipeline.saveNotes(meetingId, s.org.id, {
    title: null,
    summary: "Agreed the scope.",
    highlights: [],
    topics: [],
    actions: [
      { kind: "task", payload: { title: "Send the brief" } },
      { kind: "task", payload: { title: "Book the room" } },
    ],
    model: "recorded",
    promptVersion: 1,
  });
  const [first] = await db
    .select()
    .from(meetingsActions)
    .where(eq(meetingsActions.meetingId, meetingId))
    .orderBy(meetingsActions.seq);
  ok(await forMember(db, s.dana.id).meetings.decideAction(first!.id, { accept: false }));
  ok(await forMember(db, s.dana.id).meetings.setRecord(meetingId, deal));
  const tab = ok(
    await forMember(db, s.ben.id).meetings.on({ record: deal, addresses: [], domains: [] }),
  );
  expect(tab.meetings).toMatchObject([
    { id: meetingId, summary: "Agreed the scope.", openActions: 1, placed: true },
  ]);
});

test("a calendar task finds the meeting it was accepted from, only for who can open that meeting", async () => {
  const s = await studio();
  const meetingId = await recorded(s.dana.id, "Kickoff", [s.dana.address], day(1));
  const [action] = await db
    .insert(meetingsActions)
    .values({ meetingId, orgId: s.org.id, seq: 0, kind: "task", payload: { title: "Send it" } })
    .returning();
  const taskId = randomUUID();
  ok(await forMember(db, s.dana.id).meetings.decideAction(action!.id, { accept: true, taskId }));

  expect(ok(await forMember(db, s.dana.id).meetings.taskMeeting(taskId))).toMatchObject({
    actionId: action!.id,
    meeting: { id: meetingId, title: "Kickoff" },
  });
  expect(await forMember(db, s.ben.id).meetings.taskMeeting(taskId)).toEqual({
    status: "not_found",
  });
  expect(await forMember(db, s.dana.id).meetings.taskMeeting(randomUUID())).toEqual({
    status: "not_found",
  });
});

test("taking a meeting off a project leaves it where someone moved it meanwhile, and takes an unplaced one off every record", async () => {
  const s = await studio();
  const a = { kind: "deal" as const, id: randomUUID() };
  const b = { kind: "deal" as const, id: randomUUID() };
  const dana = forMember(db, s.dana.id).meetings;
  const moved = await recorded(s.dana.id, "Moved", [s.dana.address], day(1));
  ok(await dana.setRecord(moved, a));
  ok(await dana.setRecord(moved, b));
  expect(ok(await dana.takeOff(moved, a)).taken).toBe(false);
  expect(ok(await dana.get(moved)).meeting).toMatchObject({ record: b, recordOff: false });

  const unplaced = await recorded(s.dana.id, "Unplaced", [s.dana.address], day(2));
  expect(ok(await dana.takeOff(unplaced, a)).taken).toBe(true);
  expect(ok(await dana.get(unplaced)).meeting).toMatchObject({ record: null, recordOff: true });
  expect(await forMember(db, s.ben.id).meetings.takeOff(unplaced, a)).toEqual({
    status: "not_found",
  });
});
