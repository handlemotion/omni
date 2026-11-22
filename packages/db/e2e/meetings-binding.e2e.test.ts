import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readGoogleEvent, type GoogleCalendarChange } from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { applyGoogleChanges } from "../src/calendar.ts";
import { calendarOf } from "../src/calendar/core.ts";
import { forMember } from "../src/for-member.ts";
import { meetingsPipeline } from "../src/meetings.ts";
import {
  calendarEvents,
  mailboxes,
  meetingsAttendees,
  meetingsChunks,
  meetingsMeetings,
} from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const page = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../fixtures/google-calendar/events-page.json"),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };

const KICKOFF = "3k9a7v1q2b5c8d0e4f6g";
const SERIES = "f0c5s1k2wq9series";
const KICKOFF_UID = `${KICKOFF}@google.com`;
const SERIES_UID = `${SERIES}@google.com`;
const NOV_2 = "2026-11-02T09:00:00.000Z";
const NOV_9_EXCLUDED = "2026-11-09T09:00:00.000Z";
const NOV_16_MOVED = "2026-11-16T09:00:00.000Z";
const NOV_23_CANCELLED = "2026-11-23T09:00:00.000Z";

const changesOf = (items: Record<string, unknown>[]) =>
  items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function studio() {
  const org = await createOrg(db, `bind-${randomUUID().slice(0, 8)}`);
  const dana = await createMember(db, org.id, "dana");
  const ben = await createMember(db, org.id, "ben");
  const box = await createMailbox(db, org.id, "rodrigo@studio.example");
  await db
    .update(mailboxes)
    .set({ provider: "gmail", kind: "personal" })
    .where(eq(mailboxes.id, box.id));
  await grant(db, org.id, box.id, dana.id);
  const calendar = { id: await calendarOf(db, box), orgId: org.id };
  await applyGoogleChanges(db, calendar, changesOf(page.items));
  return { org, dana, ben, box, calendar };
}

async function rowOf(calendarId: string, uid: string, recurrenceId: string | null = null) {
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.uid, uid)));
  const row = rows.find((r) => (r.recurrenceId?.toISOString() ?? null) === recurrenceId);
  if (!row) throw new Error(`no row for ${uid} ${recurrenceId}`);
  return row;
}

type Choice = Parameters<ReturnType<typeof forMember>["meetings"]["start"]>[0]["event"];

function start(memberId: string, event: Choice) {
  return forMember(db, memberId).meetings.start({
    title: null,
    event,
    attendees: [],
    ownDomains: ["studio.example"],
    consent: true,
  });
}

const stop = (meetingId: string) =>
  meetingsPipeline(db).stopRecording(meetingId, {
    endedAt: new Date(),
    durationMs: 1000,
    audioNodeId: null,
    chunkCount: null,
    micSpans: null,
    cuts: [],
  });

const meetingRow = async (id: string) =>
  (await db.select().from(meetingsMeetings).where(eq(meetingsMeetings.id, id)))[0]!;

describe("a recording is bound to its calendar meeting on the server", () => {
  test("recording an event takes its identity, title and attendees from the calendar, not the client", async () => {
    const s = await studio();
    const kickoff = await rowOf(s.calendar.id, KICKOFF_UID);
    const { meetingId } = ok(
      await forMember(db, s.dana.id).meetings.start({
        title: null,
        event: { id: kickoff.id, recurrenceId: null },
        attendees: [{ address: "extra@partner.example", name: "Extra" }],
        ownDomains: ["studio.example"],
        consent: true,
      }),
    );
    const meeting = await meetingRow(meetingId);
    expect(meeting).toMatchObject({
      eventUid: KICKOFF_UID,
      eventRecurrenceId: "",
      title: "Acme × Studio: kickoff",
      groupKey: "domain:acme.example",
    });
    const attendees = await db
      .select({ address: meetingsAttendees.address })
      .from(meetingsAttendees)
      .where(eq(meetingsAttendees.meetingId, meetingId));
    expect(attendees.map((a) => a.address).toSorted()).toEqual([
      "ana@acme.example",
      "extra@partner.example",
      "lee@acme.example",
      "rodrigo@studio.example",
    ]);
  });

  test("an event the recorder cannot see, or that is not there, is refused rather than trusted", async () => {
    const s = await studio();
    const kickoff = await rowOf(s.calendar.id, KICKOFF_UID);
    expect(await start(s.ben.id, { id: kickoff.id, recurrenceId: null })).toEqual({
      status: "event_not_found",
    });
    expect(await start(s.ben.id, { uid: KICKOFF_UID, recurrenceId: null })).toEqual({
      status: "event_not_found",
    });
    expect(await start(s.dana.id, { uid: `made-up-${randomUUID()}`, recurrenceId: null })).toEqual({
      status: "event_not_found",
    });
  });

  test("a series is bound by instance: a moved instance is one meeting however it is reached, and excluded or cancelled ones are not there", async () => {
    const s = await studio();
    const series = await rowOf(s.calendar.id, SERIES_UID);
    const moved = await rowOf(s.calendar.id, SERIES_UID, NOV_16_MOVED);

    const nov2 = ok(await start(s.dana.id, { id: series.id, recurrenceId: NOV_2 }));
    expect(await meetingRow(nov2.meetingId)).toMatchObject({
      eventUid: SERIES_UID,
      eventRecurrenceId: NOV_2,
      groupKey: `series:${SERIES_UID}`,
      title: "Weekly sync",
    });

    const fromMoved = ok(await start(s.dana.id, { id: moved.id, recurrenceId: NOV_16_MOVED }));
    expect(await meetingRow(fromMoved.meetingId)).toMatchObject({
      eventRecurrenceId: NOV_16_MOVED,
      title: "Weekly sync (moved)",
    });
    expect(
      await start(s.dana.id, { id: series.id, recurrenceId: "2026-11-16T10:00:00+01:00" }),
    ).toEqual({
      status: "recording_elsewhere",
      meetingId: fromMoved.meetingId,
      recordedByMemberId: s.dana.id,
    });

    expect(await start(s.dana.id, { id: series.id, recurrenceId: NOV_9_EXCLUDED })).toEqual({
      status: "event_not_found",
    });
    expect(await start(s.dana.id, { id: series.id, recurrenceId: NOV_23_CANCELLED })).toEqual({
      status: "event_not_found",
    });
    expect(await start(s.dana.id, { id: series.id, recurrenceId: null })).toEqual({
      status: "event_not_found",
    });
  });

  test("the same meeting on two inboxes is recorded once, and the two starting at once get one recording", async () => {
    const s = await studio();
    const hello = await createMailbox(db, s.org.id, "hello@studio.example");
    await grant(db, s.org.id, hello.id, s.ben.id);
    const helloCalendar = { id: await calendarOf(db, hello), orgId: s.org.id };
    await applyGoogleChanges(db, helloCalendar, changesOf(page.items));
    const danas = await rowOf(s.calendar.id, KICKOFF_UID);
    const bens = await rowOf(helloCalendar.id, KICKOFF_UID);
    expect(danas.id).not.toBe(bens.id);

    const racing = await Promise.all([
      start(s.dana.id, { id: danas.id, recurrenceId: null }),
      start(s.ben.id, { id: bens.id, recurrenceId: null }),
    ]);
    const won = racing.find((r) => r.status === "ok");
    const lost = racing.find((r) => r.status === "recording_elsewhere");
    expect(won && lost).toBeTruthy();
    expect(lost).toMatchObject({ meetingId: (won as { meetingId: string }).meetingId });

    await stop((won as { meetingId: string }).meetingId);
    const second = ok(await start(s.ben.id, { id: bens.id, recurrenceId: null }));
    expect(second.part).toBe(2);
  });

  test("a browser recording whose last chunk is three minutes old lets the event be recorded again; a desktop one never does as its next part", async () => {
    const s = await studio();
    const danas = await rowOf(s.calendar.id, KICKOFF_UID);
    const first = ok(await start(s.dana.id, { id: danas.id, recurrenceId: null }));
    const pipeline = meetingsPipeline(db);
    const quiet = new Date(Date.now() - 4 * 60_000);
    await db
      .update(meetingsMeetings)
      .set({ createdAt: quiet })
      .where(eq(meetingsMeetings.id, first.meetingId));
    expect(await start(s.dana.id, { id: danas.id, recurrenceId: null })).toMatchObject({
      status: "recording_elsewhere",
      meetingId: first.meetingId,
    });
    await pipeline.receiveChunk(first.meetingId, s.org.id, {
      seq: 0,
      size: 10,
      sha256: "a".repeat(64),
      endMs: 5000,
    });
    expect(await start(s.dana.id, { id: danas.id, recurrenceId: null })).toMatchObject({
      status: "recording_elsewhere",
      meetingId: first.meetingId,
    });

    await db
      .update(meetingsChunks)
      .set({ receivedAt: quiet })
      .where(eq(meetingsChunks.meetingId, first.meetingId));
    const second = ok(await start(s.dana.id, { id: danas.id, recurrenceId: null }));
    expect(second.part).toBe(2);
    expect(
      await pipeline.receiveChunk(first.meetingId, s.org.id, {
        seq: 1,
        size: 10,
        sha256: "b".repeat(64),
        endMs: 10_000,
      }),
    ).toBe("ok");
  });

  test("Record now binds to the meeting the recorder is in, and to nothing when they are in none", async () => {
    const s = await studio();
    const now = Date.now();
    const at = (ms: number) => ({ dateTime: new Date(now + ms).toISOString(), timeZone: "UTC" });
    const kickoff = page.items.find((i) => i.id === KICKOFF)!;
    const item = (id: string, summary: string, from: number, to: number, extra = {}) => ({
      ...kickoff,
      id,
      iCalUID: `${id}@google.com`,
      summary,
      start: at(from),
      end: at(to),
      ...extra,
    });
    await applyGoogleChanges(
      db,
      s.calendar,
      changesOf([
        item("lunch", "Lunch", -20 * 60_000, 40 * 60_000, {
          attendees: [],
          organizer: { email: "rodrigo@studio.example", self: true },
          hangoutLink: undefined,
          conferenceData: undefined,
        }),
        item("earlier", "Earlier call", -50 * 60_000, 10 * 60_000),
        item("current", "Client call", -2 * 60_000, 30 * 60_000),
        item("later", "Later call", 30 * 60_000, 60 * 60_000),
      ]),
    );
    const { meetingId } = ok(await start(s.dana.id, "now"));
    expect(await meetingRow(meetingId)).toMatchObject({
      eventUid: "current@google.com",
      title: "Client call",
    });
    expect(await start(s.dana.id, "now")).toMatchObject({
      status: "recording_elsewhere",
      meetingId,
    });

    const alone = await createMember(db, s.org.id, "alone");
    const none = ok(await start(alone.id, "now"));
    expect(await meetingRow(none.meetingId)).toMatchObject({ eventUid: null });
  });

  test("a full re-sync gives the calendar new rows, and the meeting is still the same event's", async () => {
    const s = await studio();
    const before = await rowOf(s.calendar.id, SERIES_UID, NOV_16_MOVED);
    const { meetingId } = ok(await start(s.dana.id, { id: before.id, recurrenceId: NOV_16_MOVED }));
    await stop(meetingId);

    await db.delete(calendarEvents).where(eq(calendarEvents.calendarId, s.calendar.id));
    await applyGoogleChanges(db, s.calendar, changesOf(page.items));
    const after = await rowOf(s.calendar.id, SERIES_UID, NOV_16_MOVED);
    expect(after.id).not.toBe(before.id);

    const found = ok(
      await forMember(db, s.dana.id).meetings.list({
        event: { uid: SERIES_UID, recurrenceId: NOV_16_MOVED },
      }),
    );
    expect(found.meetings.map((m) => m.id)).toEqual([meetingId]);
    const next = ok(await start(s.dana.id, { id: after.id, recurrenceId: NOV_16_MOVED }));
    expect(next.part).toBe(2);
  });
});
