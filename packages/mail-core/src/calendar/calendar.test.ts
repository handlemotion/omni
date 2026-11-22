import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseMessage } from "../parse.ts";
import { expandSeries, seriesEnd } from "./expand.ts";
import { CALENDAR_PART_MAX_BYTES, parseCalendar, type CalendarEvent } from "./parse.ts";
import { instantOf, resolveZone } from "./zones.ts";

const fixtures = join(import.meta.dirname, "../../../../fixtures");
const ics = (name: string) => readFileSync(join(fixtures, "ics", name), "utf8");

function eventsOf(text: string) {
  const parsed = parseCalendar(text);
  if (!parsed.ok) throw new Error(`did not parse: ${parsed.reason}`);
  return parsed.calendar;
}

const only = (text: string) => {
  const [event] = eventsOf(text).events;
  if (!event) throw new Error("no event");
  return event;
};

describe("parseCalendar", () => {
  test("a Google invitation reads its time in Madrid, its people and its Meet link", () => {
    const calendar = eventsOf(ics("google-invite.ics"));
    expect(calendar.method).toBe("REQUEST");
    const [event] = calendar.events;
    expect(event).toMatchObject({
      uid: "3k9a7v1q2b5c8d0e4f6g@google.com",
      title: "Acme × Studio: kickoff",
      start: new Date("2026-11-24T15:30:00Z"),
      end: new Date("2026-11-24T16:15:00Z"),
      allDay: false,
      timeZone: "Europe/Madrid",
      status: "confirmed",
      busy: true,
      sequence: 0,
      dtstamp: new Date("2026-11-20T09:15:03Z"),
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      organizer: { address: "ana@acme.example", name: "Ana Ruiz" },
      location: null,
      recurrenceId: null,
      rrule: null,
    });
    expect(event?.attendees).toEqual([
      { address: "ana@acme.example", name: "Ana Ruiz", role: "required", response: "accepted" },
      {
        address: "rodrigo@studio.example",
        name: "rodrigo@studio.example",
        role: "required",
        response: "needs_action",
      },
      { address: "luis@acme.example", name: "Luis Marín", role: "optional", response: "tentative" },
    ]);
  });

  test("Outlook's Windows zone name with no VTIMEZONE lands at the right instant", async () => {
    const raw = readFileSync(join(fixtures, "eml/calendar-invite-outlook.eml"));
    const { message, attachmentContents } = await parseMessage(raw);
    expect(message.attachments.map((a) => a.mimeType)).toEqual(["text/calendar"]);
    const event = only(new TextDecoder().decode(attachmentContents[0]));
    expect(resolveZone("Romance Standard Time")).toBe("Europe/Paris");
    expect(event).toMatchObject({
      title: "Onboarding call: SMS reminders setup",
      start: new Date("2026-11-18T09:00:00Z"),
      end: new Date("2026-11-18T09:30:00Z"),
      timeZone: "Europe/Paris",
      organizer: { address: "irene.sanz@clinicasalvia.example.es", name: "Irene Sanz" },
    });
  });

  test("a zone Outlook defines only by its VTIMEZONE is read through that definition", () => {
    const event = only(ics("outlook-custom-zone.ics"));
    expect(event.start).toEqual(new Date("2026-12-01T15:00:00Z"));
    expect(event.end).toEqual(new Date("2026-12-01T16:00:00Z"));
    expect(event.timeZone).toBeNull();
    expect(event.conferenceUrl).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%7d",
    );
  });

  test("an all-day event is days, not midnights in UTC, and a free one is not busy", () => {
    const event = only(ics("apple-all-day.ics"));
    expect(event).toMatchObject({
      allDay: true,
      startDay: "2026-12-03",
      endDay: "2026-12-05",
      start: new Date("2026-12-03T00:00:00Z"),
      end: new Date("2026-12-05T00:00:00Z"),
      busy: false,
      sequence: 1,
      organizer: { address: "bea@studio.example", name: "Bea Soto" },
    });
  });

  test("a cancellation is cancelled even when it says nothing of its status", () => {
    const text = ics("cancel.ics").replace("STATUS:CANCELLED\n", "");
    const calendar = eventsOf(text);
    expect(calendar.method).toBe("CANCEL");
    expect(calendar.events[0]?.status).toBe("cancelled");
  });

  test("a reply carries only its sender's answer", () => {
    const calendar = eventsOf(ics("reply.ics"));
    expect(calendar.method).toBe("REPLY");
    expect(calendar.events[0]?.attendees).toEqual([
      { address: "luis@acme.example", name: "Luis Marín", role: "required", response: "declined" },
    ]);
  });

  test("a part over the size cap, or one that is not iCalendar, is refused, not thrown", () => {
    const huge = ics("google-invite.ics").replace(
      "SUMMARY:",
      `X-PAD:${"x".repeat(CALENDAR_PART_MAX_BYTES)}\nSUMMARY:`,
    );
    expect(parseCalendar(huge)).toEqual({ ok: false, reason: "too_large" });
    expect(parseCalendar("hello")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseCalendar("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n")).toEqual({
      ok: false,
      reason: "no_events",
    });
  });

  test("a link that is not https never comes out as the call link", () => {
    const text = ics("google-invite.ics").replace(
      "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
      "X-GOOGLE-CONFERENCE:javascript:alert(1)",
    );
    const event = only(text.replace(/DESCRIPTION:[\s\S]*?LAST-MODIFIED/, "LAST-MODIFIED"));
    expect(event.conferenceUrl).toBeNull();
  });
});

describe("expandSeries", () => {
  const [series, moved] = eventsOf(ics("weekly-series.ics")).events as [
    CalendarEvent,
    CalendarEvent,
  ];

  test("a weekly series keeps its local hour across the change to winter time", () => {
    const instances = expandSeries(series, {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
    expect(instances.map((i) => i.start.toISOString())).toEqual([
      "2026-10-19T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
    expect(instances[1]?.end).toEqual(new Date("2026-10-26T09:30:00Z"));
  });

  test("an EXDATE removes its instance, and UNTIL in UTC keeps the last one", () => {
    const starts = expandSeries(series, {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    }).map((i) => i.start.toISOString().slice(0, 10));
    expect(starts).toEqual([
      "2026-10-19",
      "2026-10-26",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
      "2026-12-07",
      "2026-12-14",
    ]);
    expect(seriesEnd(series)).toEqual(new Date("2026-12-14T09:30:00Z"));
  });

  test("a changed instance names the instance it replaces", () => {
    expect(moved.recurrenceId).toEqual(new Date("2026-11-09T09:00:00Z"));
    expect(moved.rrule).toBeNull();
    const nov9 = expandSeries(series, {
      from: new Date("2026-11-09T00:00:00Z"),
      to: new Date("2026-11-10T00:00:00Z"),
    });
    expect(nov9.map((i) => i.recurrenceId)).toEqual([moved.recurrenceId]);
  });

  test("an endless series stops at the window and the cap", () => {
    const daily = {
      ...series,
      rrule: "FREQ=DAILY",
      exdates: [],
    };
    expect(seriesEnd(daily)).toBeNull();
    const window = { from: new Date("2030-01-01T00:00:00Z"), to: new Date("2030-01-08T00:00:00Z") };
    expect(expandSeries(daily, window)).toHaveLength(7);
    expect(expandSeries(daily, window, 3)).toHaveLength(3);
  });

  test("a repeating all-day event repeats its days", () => {
    const allDay = only(ics("apple-all-day.ics"));
    const yearly = { ...allDay, rrule: "FREQ=YEARLY;COUNT=2" };
    const instances = expandSeries(yearly, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2028-01-01T00:00:00Z"),
    });
    expect(instances.map((i) => [i.startDay, i.endDay])).toEqual([
      ["2026-12-03", "2026-12-05"],
      ["2027-12-03", "2027-12-05"],
    ]);
  });
});

describe("instantOf", () => {
  test("a time the clocks skip lands an hour later; one they repeat, on the first", () => {
    const skipped = { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 };
    expect(instantOf(skipped, "Europe/Madrid")).toEqual(new Date("2026-03-29T01:30:00Z"));
    const repeated = { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 };
    expect(instantOf(repeated, "Europe/Madrid")).toEqual(new Date("2026-10-25T00:30:00Z"));
  });
});
