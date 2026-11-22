import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCalendar,
  readGoogleEvent,
  type GoogleCalendarChange,
} from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import {
  applyCalendarPart,
  applyGoogleChanges,
  calendarArrivals,
  claimGoogleCalendars,
  finishGoogleFullSync,
  saveGoogleSync,
} from "../src/calendar.ts";
import { calendarOf } from "../src/calendar/core.ts";
import { forMember } from "../src/for-member.ts";
import { addLocation, liveGmailMailboxes } from "../src/mail/mail-sync.ts";
import { createThread, upsertFolder, upsertMessage } from "../src/mail/writers.ts";
import { calendarEvents, mailboxes } from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const fixtures = join(import.meta.dirname, "../../../fixtures");
const page = JSON.parse(
  readFileSync(join(fixtures, "google-calendar/events-page.json"), "utf8"),
) as { timeZone: string; items: Record<string, unknown>[] };
const invite = readFileSync(join(fixtures, "ics/google-invite.ics"), "utf8");

const KICKOFF = "3k9a7v1q2b5c8d0e4f6g";
const NOV = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") };

function changes(items: Record<string, unknown>[] = page.items) {
  return items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);
}

const itemOf = (id: string) => {
  const found = page.items.find((item) => item.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

async function gmailInbox(slug: string) {
  const org = await createOrg(db, `${slug}-${crypto.randomUUID().slice(0, 8)}`);
  const rodrigo = await createMember(db, org.id, "rodrigo");
  const box = await createMailbox(db, org.id, "rodrigo@studio.example");
  await db
    .update(mailboxes)
    .set({ provider: "gmail", kind: "personal" })
    .where(eq(mailboxes.id, box.id));
  await grant(db, org.id, box.id, rodrigo.id);
  const calendar = { id: await calendarOf(db, box), orgId: org.id };
  return { org, rodrigo, box, calendar };
}

async function shown(memberId: string) {
  const found = await forMember(db, memberId).calendar.events(NOV);
  if (found.status !== "ok") throw new Error(found.status);
  return found.events.map((e) => `${e.start.toISOString()} ${e.title}`);
}

let imapUid = 0;

async function deliverInvite(box: { id: string; orgId: string }) {
  const folder = await upsertFolder(db, {
    orgId: box.orgId,
    mailboxId: box.id,
    path: "INBOX",
    role: "inbox",
    uidvalidity: 1,
    uidnext: 1000,
    highestModseq: null,
  });
  const sentAt = new Date();
  const threadId = await createThread(db, {
    orgId: box.orgId,
    mailboxId: box.id,
    subjectKey: "invitation",
    lastMessageAt: sentAt,
  });
  const message = await upsertMessage(db, {
    orgId: box.orgId,
    mailboxId: box.id,
    threadId,
    folderId: folder.id,
    imapUid: ++imapUid,
    messageIdHeader: `<${crypto.randomUUID()}@example.test>`,
    subject: "Invitation",
    fromAddress: "ana@acme.example",
    to: [],
    sentAt,
    cleanText: "Invitation",
    attachments: [
      {
        filename: "invite.ics",
        mimeType: "text/calendar",
        size: invite.length,
        r2Key: `${box.orgId}/${box.id}/att/${crypto.randomUUID()}`,
      },
    ],
  });
  await addLocation(db, {
    orgId: box.orgId,
    mailboxId: box.id,
    folderId: folder.id,
    uid: imapUid,
    messageId: message.id,
    flags: [],
    modseq: null,
  });
  const [part] = await calendarArrivals(db, [message.id]);
  if (!part) throw new Error("no calendar part");
  return applyCalendarPart(db, part, parseCalendar(invite));
}

const rowsOf = (calendarId: string, uid: string) =>
  db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.calendarId, calendarId), eq(calendarEvents.uid, uid)));

describe("a Gmail inbox's Google Calendar", () => {
  test("one page fills the calendar: a moved instance shows moved, cancelled and excluded ones do not, a working location never", async () => {
    const { rodrigo, calendar } = await gmailInbox("google-fill");
    expect((await applyGoogleChanges(db, calendar, changes())).changed).toBeGreaterThan(0);
    expect(await shown(rodrigo.id)).toEqual([
      "2026-11-02T09:00:00.000Z Weekly sync",
      "2026-11-16T11:00:00.000Z Weekly sync (moved)",
      "2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
      "2026-11-26T09:00:00.000Z Dentist",
      "2026-11-30T09:00:00.000Z Weekly sync",
      "2026-12-03T00:00:00.000Z Offsite",
      "2026-12-07T09:00:00.000Z Weekly sync",
      "2026-12-14T09:00:00.000Z Weekly sync",
      "2026-12-21T09:00:00.000Z Weekly sync",
      "2026-12-28T09:00:00.000Z Weekly sync",
    ]);
    const [kickoff] = await rowsOf(calendar.id, `${KICKOFF}@google.com`);
    expect(kickoff).toMatchObject({ source: "google", googleId: KICKOFF });
  });

  test("the same page applied again changes nothing", async () => {
    const { calendar } = await gmailInbox("google-twice");
    await applyGoogleChanges(db, calendar, changes());
    expect(await applyGoogleChanges(db, calendar, changes())).toEqual({ changed: 0, waiting: [] });
  });

  test("a full pass that sees the same page again keeps a cancelled instance cancelled", async () => {
    const { rodrigo, calendar } = await gmailInbox("google-full-instance");
    await applyGoogleChanges(db, calendar, changes());
    const before = await shown(rodrigo.id);
    const startedAt = new Date(Date.now() + 60_000);
    await applyGoogleChanges(db, calendar, changes(), new Date(startedAt.getTime() + 1_000));
    await finishGoogleFullSync(db, calendar.id, startedAt);
    expect(await shown(rodrigo.id)).toEqual(before);
    expect(before).not.toContain("2026-11-23T09:00:00.000Z Weekly sync");
  });

  test("a cancelled instance listed before its series waits for it, then hides that instance", async () => {
    const { rodrigo, calendar } = await gmailInbox("google-instance-first");
    const cancelled = changes([itemOf("f0c5s1k2wq9series_20261123T090000Z")]);
    const first = await applyGoogleChanges(db, calendar, cancelled);
    expect(first.waiting).toEqual(cancelled);
    const second = await applyGoogleChanges(db, calendar, [
      ...changes([itemOf("f0c5s1k2wq9series")]),
      ...first.waiting,
    ]);
    expect(second.waiting).toEqual([]);
    expect(await shown(rodrigo.id)).not.toContain("2026-11-23T09:00:00.000Z Weekly sync");
    expect(await shown(rodrigo.id)).toContain("2026-11-30T09:00:00.000Z Weekly sync");
  });

  test("a meeting deleted in Google stays deleted when its invitation for the same version lands later", async () => {
    const { box, rodrigo, calendar } = await gmailInbox("google-delete-then-mail");
    const early = { ...itemOf(KICKOFF), sequence: 0, updated: "2026-11-19T00:00:00.000Z" };
    await applyGoogleChanges(db, calendar, changes([early]));
    await applyGoogleChanges(db, calendar, changes([{ id: KICKOFF, status: "cancelled" }]));
    expect(await deliverInvite(box)).toMatchObject({ status: "stale" });
    expect(await shown(rodrigo.id)).toEqual([]);
  });

  test("a meeting Google listed first and mail then brought survives a full pass that no longer sees it", async () => {
    const { box, rodrigo, calendar } = await gmailInbox("google-then-mail");
    await applyGoogleChanges(db, calendar, changes([itemOf(KICKOFF)]));
    expect(await deliverInvite(box)).toMatchObject({ status: "stale" });
    const startedAt = new Date(Date.now() + 60_000);
    expect(await finishGoogleFullSync(db, calendar.id, startedAt)).toBe(0);
    expect(await shown(rodrigo.id)).toEqual(["2026-11-24T15:30:00.000Z Acme × Studio: kickoff"]);
  });

  test("an invitation in mail and the same meeting in Google are one event, whichever lands first", async () => {
    const first = await gmailInbox("google-after-invite");
    expect(await deliverInvite(first.box)).toMatchObject({ status: "applied" });
    await applyGoogleChanges(db, first.calendar, changes([itemOf(KICKOFF)]));

    const second = await gmailInbox("google-before-invite");
    await applyGoogleChanges(db, second.calendar, changes([itemOf(KICKOFF)]));
    expect(await deliverInvite(second.box)).toMatchObject({ status: "stale" });

    for (const { calendar, rodrigo } of [first, second]) {
      const rows = await rowsOf(calendar.id, `${KICKOFF}@google.com`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sequence: 2, googleId: KICKOFF });
      const found = await forMember(db, rodrigo.id).calendar.events(NOV);
      expect(found.status === "ok" && found.events[0]?.myResponse).toBe("tentative");
    }
  });

  test("an event made in Omni is Omni's: Google never changes or cancels it", async () => {
    const { rodrigo, calendar } = await gmailInbox("google-omni");
    const made = await forMember(db, rodrigo.id).calendar.createEvent({
      calendarId: calendar.id,
      title: "Planning",
      start: new Date("2026-11-24T15:30:00Z"),
      end: new Date("2026-11-24T16:00:00Z"),
    });
    if (made.status !== "ok") throw new Error(made.status);
    const [own] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, made.eventId));
    if (!own) throw new Error("no event");
    const google = { ...itemOf(KICKOFF), id: "omni-copy", iCalUID: own.uid, sequence: 9 };
    expect((await applyGoogleChanges(db, calendar, changes([google]))).changed).toBe(0);
    await applyGoogleChanges(db, calendar, changes([{ id: "omni-copy", status: "cancelled" }]));
    const [after] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, own.id));
    expect(after).toMatchObject({ title: "Planning", source: "omni", status: "confirmed" });
  });

  test("an event deleted in Google, which comes back as its id alone, leaves the calendar", async () => {
    const { rodrigo, calendar } = await gmailInbox("google-delete");
    await applyGoogleChanges(db, calendar, changes([itemOf(KICKOFF)]));
    expect(await shown(rodrigo.id)).toContain("2026-11-24T15:30:00.000Z Acme × Studio: kickoff");
    await applyGoogleChanges(db, calendar, changes([{ id: KICKOFF, status: "cancelled" }]));
    expect(await shown(rodrigo.id)).toEqual([]);
  });

  test("a full pass drops the Google events Google no longer has, and keeps what mail brought", async () => {
    const { box, rodrigo, calendar } = await gmailInbox("google-full");
    await applyGoogleChanges(db, calendar, changes([itemOf("7wl3floating")]));
    await deliverInvite(box);
    const startedAt = new Date(Date.now() + 60_000);
    await applyGoogleChanges(
      db,
      calendar,
      changes([itemOf("4n1allday")]),
      new Date(startedAt.getTime() + 1_000),
    );
    expect(await finishGoogleFullSync(db, calendar.id, startedAt)).toBe(1);
    expect(await shown(rodrigo.id)).toEqual([
      "2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
      "2026-12-03T00:00:00.000Z Offsite",
    ]);
  });
});

describe("claiming Google calendars", () => {
  test("a due calendar is claimed by one pass at a time, and again once its next time comes", async () => {
    const { box, calendar } = await gmailInbox("google-claim");
    const live = (await liveGmailMailboxes(db)).filter((m) => m.id === box.id);
    expect(live).toHaveLength(1);
    const now = new Date();
    const [claim] = await claimGoogleCalendars(db, live, { now });
    expect(claim).toMatchObject({ calendarId: calendar.id, mailboxId: box.id, syncToken: null });
    expect(await claimGoogleCalendars(db, live, { now })).toEqual([]);

    await saveGoogleSync(db, calendar.id, {
      syncToken: "token-1",
      pageToken: null,
      fullSyncStartedAt: null,
      state: "ok",
      nextSyncAt: new Date(now.getTime() + 60_000),
    });
    expect(await claimGoogleCalendars(db, live, { now })).toEqual([]);
    const [again] = await claimGoogleCalendars(db, live, { now: new Date(now.getTime() + 61_000) });
    expect(again).toMatchObject({ calendarId: calendar.id, syncToken: "token-1" });
  });

  test("a disabled Gmail inbox is not synced", async () => {
    const { box } = await gmailInbox("google-disabled");
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, box.id));
    expect((await liveGmailMailboxes(db)).some((m) => m.id === box.id)).toBe(false);
  });
});
