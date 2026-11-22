import { parseCalendar } from "@omni/mail-core/calendar";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startCrmStack, type CrmStack, type Person } from "./crm-support.ts";
import { createMailbox, grant } from "./support.ts";

let stack: CrmStack;
beforeAll(async () => {
  stack = await startCrmStack({ vars: { RATE_LIMIT_BOOKING_NEW: "off" } });
}, 60_000);
afterAll(() => stack?.stop());

type Json = Record<string, unknown> | null;

async function call(path: string, init: { method?: string; jar?: Person["jar"]; body?: unknown }) {
  const response = await fetch(new URL(path, stack.worker.url), {
    method: init.method ?? "GET",
    headers: {
      ...(init.jar ? { cookie: init.jar.header } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
  return { status: response.status, text, body: (text ? JSON.parse(text) : null) as any as Json };
}

const DAY = 86_400_000;
const tomorrowAt = (hour: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, hour),
  ).toISOString();
};

const sends = (mailboxId: string) =>
  stack.db
    .select()
    .from(schema.mailActions)
    .where(and(eq(schema.mailActions.mailboxId, mailboxId), eq(schema.mailActions.kind, "send")))
    .orderBy(schema.mailActions.createdAt);

async function owner() {
  const org = await stack.company(`book-${crypto.randomUUID().slice(0, 8)}`);
  const rodrigo = await stack.member(org.id);
  const address = `rodrigo-${crypto.randomUUID().slice(0, 6)}@studio.example`;
  const inbox = await createMailbox(stack.db, org.id, address, "personal");
  await grant(stack.db, org.id, inbox.id, rodrigo.id);
  const listed = await call("/api/calendar/calendars", { jar: rodrigo.jar });
  const calendars = (listed.body?.calendars ?? []) as { id: string; mailboxId: string }[];
  const calendarId = calendars.find((c) => c.mailboxId === inbox.id)!.id;
  const made = await call("/api/calendar/booking-links", {
    method: "POST",
    jar: rodrigo.jar,
    body: {
      calendarId,
      title: "Intro call",
      durationMinutes: 60,
      timeZone: "UTC",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 9 * 60,
      endMinute: 17 * 60,
      noticeMinutes: 0,
      horizonDays: 3,
    },
  });
  expect(made.status).toBe(201);
  const link = made.body?.link as { id: string; slug: string };
  return { org, rodrigo, inbox, address, calendarId, link };
}

const book = (slug: string, start: string, email = "ana@acme.example") =>
  call(`/api/booking/${slug}`, {
    method: "POST",
    body: { start, name: "Ana", email, note: "About the rebrand", timeZone: "Europe/Madrid" },
  });

describe("booking links", () => {
  test("the public page offers free slots only, and nothing of the event that fills the rest", async () => {
    const { rodrigo, calendarId, link } = await owner();
    const busy = await call("/api/calendar/events", {
      method: "POST",
      jar: rodrigo.jar,
      body: {
        calendarId,
        title: "Secret board meeting",
        location: "Room 4",
        start: tomorrowAt(10),
        end: tomorrowAt(11),
        guests: [{ address: "cfo@acme.example", name: "Cfo" }],
      },
    });
    expect(busy.status).toBe(201);

    const page = await call(`/api/booking/${link.slug}`, {});
    expect(page.status).toBe(200);
    const slots = page.body?.slots as string[];
    expect(slots).toContain(new Date(tomorrowAt(9)).toISOString());
    expect(slots).not.toContain(new Date(tomorrowAt(10)).toISOString());
    expect(slots).toContain(new Date(tomorrowAt(11)).toISOString());
    expect(page.body).toMatchObject({ title: "Intro call", durationMinutes: 60, timeZone: "UTC" });
    for (const secret of ["Secret board meeting", "Room 4", "cfo@acme.example"]) {
      expect(page.text).not.toContain(secret);
    }
  });

  test("booking puts the meeting on the owner's calendar and invites the visitor from the inbox; the same slot again is refused", async () => {
    const { rodrigo, inbox, address, link } = await owner();
    const start = tomorrowAt(14);
    const booked = await book(link.slug, start);
    expect(booked.status).toBe(201);
    expect(booked.body).toEqual({
      start: new Date(start).toISOString(),
      end: new Date(Date.parse(start) + 3_600_000).toISOString(),
    });

    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + 4 * DAY).toISOString();
    const events = await call(`/api/calendar/events?from=${from}&to=${to}`, { jar: rodrigo.jar });
    expect(events.body?.events).toEqual([
      expect.objectContaining({
        title: "Intro call (Ana)",
        description: "About the rebrand",
        start: new Date(start).toISOString(),
        organizing: true,
        attendees: expect.arrayContaining([
          expect.objectContaining({ address: "ana@acme.example", response: "needs_action" }),
        ]),
      }),
    ]);

    const queued = await sends(inbox.id);
    expect(queued).toHaveLength(1);
    const payload = queued[0]!.payload as { from: string; to: string[]; calendar: { ics: string } };
    expect(payload.to).toEqual(["ana@acme.example"]);
    const parsed = parseCalendar(payload.calendar.ics);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.calendar).toMatchObject({ method: "REQUEST" });
    expect(parsed.calendar.events[0]).toMatchObject({ organizer: { address } });

    const again = await book(link.slug, start, "luis@acme.example");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "SLOT_TAKEN" });
    const page = await call(`/api/booking/${link.slug}`, {});
    expect(page.body?.slots).not.toContain(new Date(start).toISOString());
    expect(await sends(inbox.id)).toHaveLength(1);
  });

  test("two visitors booking the same slot at once get one meeting", async () => {
    const { inbox, link } = await owner();
    const start = tomorrowAt(15);
    const answers = await Promise.all([
      book(link.slug, start, "ana@acme.example"),
      book(link.slug, start, "luis@acme.example"),
    ]);
    expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409]);
    expect(await sends(inbox.id)).toHaveLength(1);
  });

  test("two members' links on one shared inbox never book the same time twice", async () => {
    const org = await stack.company(`shared-${crypto.randomUUID().slice(0, 8)}`);
    const ana = await stack.member(org.id);
    const luis = await stack.member(org.id);
    const inbox = await createMailbox(
      stack.db,
      org.id,
      `hello-${crypto.randomUUID().slice(0, 6)}@studio.example`,
    );
    await grant(stack.db, org.id, inbox.id, ana.id);
    await grant(stack.db, org.id, inbox.id, luis.id);
    const slugs = await Promise.all(
      [ana, luis].map(async (person) => {
        const listed = await call("/api/calendar/calendars", { jar: person.jar });
        const calendars = (listed.body?.calendars ?? []) as { id: string; mailboxId: string }[];
        const made = await call("/api/calendar/booking-links", {
          method: "POST",
          jar: person.jar,
          body: {
            calendarId: calendars.find((c) => c.mailboxId === inbox.id)!.id,
            title: "Studio call",
            durationMinutes: 60,
            timeZone: "UTC",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            noticeMinutes: 0,
            horizonDays: 3,
          },
        });
        expect(made.status).toBe(201);
        return (made.body as { link: { slug: string } }).link.slug;
      }),
    );
    const start = tomorrowAt(16);
    const answers = await Promise.all([
      book(slugs[0]!, start, "ana@acme.example"),
      book(slugs[1]!, start, "luis@acme.example"),
    ]);
    expect(answers.map((a) => a.status).toSorted()).toEqual([201, 409]);
    expect(await sends(inbox.id)).toHaveLength(1);
  });

  test("a time the link does not offer is refused: outside its hours, or off its grid", async () => {
    const { inbox, link } = await owner();
    expect((await book(link.slug, tomorrowAt(3))).status).toBe(409);
    const offGrid = new Date(Date.parse(tomorrowAt(9)) + 15 * 60_000).toISOString();
    expect((await book(link.slug, offGrid)).status).toBe(409);
    expect(await sends(inbox.id)).toEqual([]);
  });

  test("a deleted link, or one whose owner lost the inbox, answers 404, and a teammate cannot touch it", async () => {
    const { org, rodrigo, inbox, link } = await owner();
    const teammate = await stack.member(org.id);
    const theirs = await call("/api/calendar/booking-links", { jar: teammate.jar });
    expect(theirs.body?.links).toEqual([]);
    const taken = await call(`/api/calendar/booking-links/${link.id}`, {
      method: "DELETE",
      jar: teammate.jar,
    });
    expect(taken.status).toBe(404);
    expect((await call(`/api/booking/${link.slug}`, {})).status).toBe(200);

    await stack.db
      .delete(schema.mailboxAccess)
      .where(
        and(
          eq(schema.mailboxAccess.mailboxId, inbox.id),
          eq(schema.mailboxAccess.memberId, rodrigo.id),
        ),
      );
    expect((await call(`/api/booking/${link.slug}`, {})).status).toBe(404);
    expect((await book(link.slug, tomorrowAt(9))).status).toBe(404);

    await grant(stack.db, org.id, inbox.id, rodrigo.id);
    expect((await call(`/api/booking/${link.slug}`, {})).status).toBe(200);
    const deleted = await call(`/api/calendar/booking-links/${link.id}`, {
      method: "DELETE",
      jar: rodrigo.jar,
    });
    expect(deleted.status).toBe(204);
    expect((await call(`/api/booking/${link.slug}`, {})).status).toBe(404);
  });

  test("a link on a calendar the member cannot open is refused", async () => {
    const { org, calendarId } = await owner();
    const teammate = await stack.member(org.id);
    const made = await call("/api/calendar/booking-links", {
      method: "POST",
      jar: teammate.jar,
      body: { calendarId, title: "Sneaky", durationMinutes: 30, timeZone: "UTC" },
    });
    expect(made.status).toBe(404);
  });
});
