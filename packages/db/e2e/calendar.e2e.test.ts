import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCalendar } from "@omni/mail-core/calendar";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import {
  advanceCalendarSweep,
  applyCalendarPart,
  calendarArrivals,
  calendarSweepPage,
} from "../src/calendar.ts";
import { forMember, forUser } from "../src/for-member.ts";
import { addLocation } from "../src/mail/mail-sync.ts";
import { createThread, upsertFolder, upsertMessage } from "../src/mail/writers.ts";
import { calendarCalendars, calendarParts, members } from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../../fixtures/ics", name), "utf8");

const NOV = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") };

let uid = 0;
const delivered = new Map<string, string>();

async function deliver(
  mailbox: { id: string; orgId: string },
  input: { ics: string; from: string; folder?: "INBOX" | "Sent" | "Junk" },
) {
  const path = input.folder ?? "INBOX";
  const folder = await upsertFolder(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    path,
    role: path === "INBOX" ? "inbox" : path === "Sent" ? "sent" : "junk",
    uidvalidity: 1,
    uidnext: 1000,
    highestModseq: null,
  });
  const sentAt = new Date();
  const threadId = await createThread(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    subjectKey: "invitation",
    lastMessageAt: sentAt,
  });
  const stored = await upsertMessage(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    threadId,
    folderId: folder.id,
    imapUid: ++uid,
    messageIdHeader: `<${crypto.randomUUID()}@example.test>`,
    subject: "Invitation",
    fromAddress: input.from,
    to: [],
    sentAt,
    cleanText: "Invitation",
    attachments: [
      {
        filename: "invite.ics",
        mimeType: "text/calendar",
        size: input.ics.length,
        r2Key: `${mailbox.orgId}/${mailbox.id}/att/${crypto.randomUUID()}`,
      },
    ],
  });
  await addLocation(db, {
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    folderId: folder.id,
    uid,
    messageId: stored.id,
    flags: [],
    modseq: null,
  });
  const [part] = await calendarArrivals(db, [stored.id]);
  if (!part) throw new Error("the attachment is not a calendar part");
  delivered.set(part.id, input.ics);
  return { part, threadId, messageId: stored.id, text: input.ics };
}

const apply = (delivered: { part: Parameters<typeof applyCalendarPart>[1]; text: string }) =>
  applyCalendarPart(db, delivered.part, parseCalendar(delivered.text));

async function workspace(slug: string, address = "rodrigo@studio.example") {
  const org = await createOrg(db, `${slug}-${crypto.randomUUID().slice(0, 8)}`);
  const rodrigo = await createMember(db, org.id, "rodrigo");
  const box = await createMailbox(db, org.id, address);
  await grant(db, org.id, box.id, rodrigo.id);
  return { org, rodrigo, box };
}

async function eventsOf(memberId: string, window = NOV) {
  const found = await forMember(db, memberId).calendar.events(window);
  if (found.status !== "ok") throw new Error(found.status);
  return found.events;
}

const summary = async (memberId: string) =>
  (await eventsOf(memberId)).map((e) => ({
    title: e.title,
    start: e.start.toISOString(),
    status: e.status,
    me: e.myResponse,
    attendees: e.attendees.map((a) => `${a.address}=${a.response}`),
  }));

describe("the calendar door", () => {
  test("only a member on the inbox sees its invitation: not a teammate, not an admin, not another workspace", async () => {
    const { org, rodrigo, box } = await workspace("door");
    const teammate = await createMember(db, org.id, "teammate");
    const admin = await createMember(db, org.id, "admin");
    await db.update(members).set({ role: "owner" }).where(eq(members.id, admin.id));
    const other = await workspace("door-other");

    expect(
      await apply(
        await deliver(box, { ics: fixture("google-invite.ics"), from: "ana@acme.example" }),
      ),
    ).toMatchObject({
      status: "applied",
    });

    const [event] = await eventsOf(rodrigo.id);
    expect(event).toMatchObject({
      title: "Acme × Studio: kickoff",
      start: new Date("2026-11-24T15:30:00Z"),
      mailboxId: box.id,
      myResponse: "needs_action",
      organizing: false,
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect((await forMember(db, rodrigo.id).calendar.event(event!.id)).status).toBe("ok");

    for (const outsider of [teammate.id, admin.id, other.rodrigo.id]) {
      expect(await eventsOf(outsider)).toEqual([]);
      expect(await forMember(db, outsider).calendar.event(event!.id)).toEqual({
        status: "not_found",
      });
    }
    const user = (await db.select().from(members).where(eq(members.id, rodrigo.id)))[0]!.userId;
    const across = await forUser(db, user).calendar.events(NOV);
    expect(across.status === "ok" && across.events.map((e) => e.id)).toEqual([event!.id]);
    const scoped = await forUser(db, user, other.org.id).calendar.events(NOV);
    expect(scoped.status === "ok" && scoped.events).toEqual([]);
  });

  test("a window longer than 62 days is refused, not expanded", async () => {
    const { rodrigo } = await workspace("window");
    const found = await forMember(db, rodrigo.id).calendar.events({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-06-01T00:00:00Z"),
    });
    expect(found).toEqual({ status: "window_too_large", maxDays: 62 });
  });
});

describe("applying invitations", () => {
  test("an update with a lower sequence changes nothing", async () => {
    const { rodrigo, box } = await workspace("stale");
    const moved = fixture("google-invite.ics")
      .replace("SEQUENCE:0", "SEQUENCE:2")
      .replace(
        "DTSTART;TZID=Europe/Madrid:20261124T163000",
        "DTSTART;TZID=Europe/Madrid:20261124T180000",
      )
      .replace(
        "DTEND;TZID=Europe/Madrid:20261124T171500",
        "DTEND;TZID=Europe/Madrid:20261124T184500",
      );
    await apply(await deliver(box, { ics: moved, from: "ana@acme.example" }));
    const old = await apply(
      await deliver(box, { ics: fixture("google-invite.ics"), from: "ana@acme.example" }),
    );
    expect(old).toMatchObject({ status: "stale", reason: "older" });
    expect((await eventsOf(rodrigo.id)).map((e) => e.start.toISOString())).toEqual([
      "2026-11-24T17:00:00.000Z",
    ]);
  });

  test("a cancellation from someone other than the organizer changes nothing", async () => {
    const { rodrigo, box } = await workspace("spoof");
    await apply(
      await deliver(box, { ics: fixture("google-invite.ics"), from: "ana@acme.example" }),
    );
    const spoofed = await apply(
      await deliver(box, { ics: fixture("cancel.ics"), from: "mallory@elsewhere.example" }),
    );
    expect(spoofed).toMatchObject({ status: "ignored", reason: "not_organizer" });
    expect((await eventsOf(rodrigo.id)).map((e) => e.status)).toEqual(["confirmed"]);

    const real = await apply(
      await deliver(box, { ics: fixture("cancel.ics"), from: "Ana@Acme.example" }),
    );
    expect(real).toMatchObject({ status: "applied" });
    expect(await eventsOf(rodrigo.id)).toEqual([]);
  });

  test("a reply changes only its sender's answer", async () => {
    const { rodrigo, box } = await workspace("reply", "ana@acme.example");
    await apply(
      await deliver(box, {
        ics: fixture("google-invite.ics"),
        from: "ana@acme.example",
        folder: "Sent",
      }),
    );
    const forged = await apply(
      await deliver(box, { ics: fixture("reply.ics"), from: "someone@else.example" }),
    );
    expect(forged).toMatchObject({ status: "ignored", reason: "not_attendee" });
    await apply(await deliver(box, { ics: fixture("reply.ics"), from: "luis@acme.example" }));
    const [event] = await eventsOf(rodrigo.id);
    expect(event?.organizing).toBe(true);
    expect(event?.attendees.map((a) => `${a.address}=${a.response}`)).toEqual([
      "ana@acme.example=accepted",
      "luis@acme.example=declined",
      "rodrigo@studio.example=needs_action",
    ]);
  });

  test("an invitation in Junk is not on the calendar", async () => {
    const { rodrigo, box } = await workspace("junk");
    const result = await apply(
      await deliver(box, {
        ics: fixture("google-invite.ics"),
        from: "ana@acme.example",
        folder: "Junk",
      }),
    );
    expect(result).toMatchObject({ status: "ignored", reason: "junk" });
    expect(await eventsOf(rodrigo.id)).toEqual([]);
  });

  test("applying a part twice changes nothing the second time", async () => {
    const { box } = await workspace("twice");
    const delivered = await deliver(box, {
      ics: fixture("google-invite.ics"),
      from: "ana@acme.example",
    });
    expect(await apply(delivered)).toMatchObject({ status: "applied" });
    expect(await apply(delivered)).toEqual({ status: "done_before" });
    expect(await calendarArrivals(db, [delivered.messageId])).toEqual([]);
  });

  test("a series shows its instances, with the moved one moved and the removed one gone", async () => {
    const { rodrigo, box } = await workspace("series");
    await apply(
      await deliver(box, { ics: fixture("weekly-series.ics"), from: "ana@acme.example" }),
    );
    const events = await eventsOf(rodrigo.id, {
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-17T00:00:00Z"),
    });
    expect(events.map((e) => [e.title, e.start.toISOString()])).toEqual([
      ["Weekly sync (moved)", "2026-11-09T10:30:00.000Z"],
      ["Weekly sync", "2026-11-16T09:00:00.000Z"],
    ]);
    expect(events.every((e) => e.recurring)).toBe(true);
  });
});

describe("convergence", () => {
  const parts = [
    { ics: fixture("google-invite.ics"), from: "ana@acme.example" },
    {
      ics: fixture("google-invite.ics")
        .replace("SEQUENCE:0", "SEQUENCE:1")
        .replace("DTSTAMP:20261120T091503Z", "DTSTAMP:20261120T110000Z")
        .replace("SUMMARY:Acme × Studio: kickoff", "SUMMARY:Acme × Studio: kickoff (v2)"),
      from: "ana@acme.example",
    },
    { ics: fixture("reply.ics"), from: "luis@acme.example" },
    { ics: fixture("weekly-series.ics"), from: "ana@acme.example" },
  ];

  test("the same mail applied in reverse order ends in the same state, a reply before its invitation included", async () => {
    const forward = await workspace("forward");
    for (const part of parts) await apply(await deliver(forward.box, part));
    const backward = await workspace("backward");
    for (const part of parts.toReversed()) await apply(await deliver(backward.box, part));

    const ahead = await summary(forward.rodrigo.id);
    const kickoff = ahead.find((e) => e.title.startsWith("Acme"));
    expect(kickoff?.title).toBe("Acme × Studio: kickoff (v2)");
    expect(kickoff?.attendees).toContain("luis@acme.example=declined");
    expect(await summary(backward.rodrigo.id)).toEqual(ahead);
  });

  test("emptying the calendar's tables and sweeping again gives the same events", async () => {
    const { org, rodrigo, box } = await workspace("rebuild");
    for (const part of parts) await apply(await deliver(box, part));
    const before = await summary(rodrigo.id);
    expect(before.length).toBeGreaterThan(1);

    await db.delete(calendarCalendars).where(eq(calendarCalendars.orgId, org.id));
    expect(await db.select().from(calendarParts).where(eq(calendarParts.orgId, org.id))).toEqual(
      [],
    );
    expect(await eventsOf(rodrigo.id)).toEqual([]);

    await db.execute(sql`delete from calendar_sweep`);
    const later = new Date(Date.now() + 10 * 60_000);
    for (let page = 0; page < 50; page++) {
      const { parts: next, last } = await calendarSweepPage(db, { now: later, limit: 3 });
      for (const part of next) {
        await applyCalendarPart(db, part, parseCalendar(delivered.get(part.id) ?? ""));
      }
      if (!last) break;
      await advanceCalendarSweep(db, last);
    }
    expect(await summary(rodrigo.id)).toEqual(before);
  });

  test("the sweep leaves an attachment younger than its settle time for the next run", async () => {
    const { box } = await workspace("settle");
    const fresh = await deliver(box, {
      ics: fixture("google-invite.ics"),
      from: "ana@acme.example",
    });
    await db.execute(sql`delete from calendar_sweep`);
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
      const { parts: next, last } = await calendarSweepPage(db, { limit: 50 });
      next.forEach((part) => seen.add(part.id));
      if (!last) break;
      await advanceCalendarSweep(db, last);
    }
    expect(seen.has(fresh.part.id)).toBe(false);
    const { parts: later } = await calendarSweepPage(db, {
      now: new Date(Date.now() + 10 * 60_000),
    });
    expect(later.map((part) => part.id)).toContain(fresh.part.id);
  });
});
