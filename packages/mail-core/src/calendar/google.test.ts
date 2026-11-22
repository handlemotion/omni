import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { expandSeries } from "./expand.ts";
import { descriptionText, readGoogleEvent, type GoogleCalendarChange } from "./google.ts";

const page = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../fixtures/google-calendar/events-page.json"),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };

function item(id: string) {
  const found = page.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

function eventOf(id: string) {
  const change = readGoogleEvent(item(id), page.timeZone);
  if (change?.kind !== "event") throw new Error(`${id} did not read as an event`);
  return change;
}

describe("readGoogleEvent", () => {
  test("a meeting keys on its iCalendar UID, so its invitation in mail lands on the same row", () => {
    const { googleId, event } = eventOf("3k9a7v1q2b5c8d0e4f6g");
    expect(googleId).toBe("3k9a7v1q2b5c8d0e4f6g");
    expect(event).toMatchObject({
      uid: "3k9a7v1q2b5c8d0e4f6g@google.com",
      recurrenceId: null,
      sequence: 2,
      dtstamp: new Date("2026-11-20T09:15:03.512Z"),
      title: "Acme × Studio: kickoff",
      start: new Date("2026-11-24T15:30:00Z"),
      end: new Date("2026-11-24T16:15:00Z"),
      allDay: false,
      timeZone: "Europe/Madrid",
      status: "confirmed",
      busy: true,
      location: "Office, Calle Mayor 1",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      organizer: { address: "ana@acme.example", name: "Ana Ruiz" },
    });
  });

  test("attendees keep their answers and roles, addresses normalized, rooms left out", () => {
    const { event } = eventOf("3k9a7v1q2b5c8d0e4f6g");
    expect(event.attendees).toEqual([
      { address: "ana@acme.example", name: "Ana Ruiz", role: "chair", response: "accepted" },
      { address: "rodrigo@studio.example", name: null, role: "required", response: "tentative" },
      { address: "lee@acme.example", name: null, role: "optional", response: "needs_action" },
    ]);
  });

  test("an HTML description reads as text, with no markup or entities left in it", () => {
    const { event } = eventOf("3k9a7v1q2b5c8d0e4f6g");
    expect(event.description).toBe("Agenda\n\n1. Scope\n2. Timeline\nBrief");
    expect(descriptionText("<ul><li>Q&amp;A</li><li>5 &lt; 6&nbsp;&#8212; ok</li></ul>")).toBe(
      "- Q&A\n- 5 < 6\u00a0— ok",
    );
    const started = performance.now();
    const hostile = readGoogleEvent({ ...item("4n1allday"), description: "<a".repeat(200_000) });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(hostile?.kind).toBe("event");
  });

  test("a weekly series keeps its rule and its zoned exception, and stays at 10:00 across winter time", () => {
    const { event } = eventOf("f0c5s1k2wq9series");
    expect(event.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(event.exdates).toEqual([new Date("2026-11-09T09:00:00Z")]);
    const starts = expandSeries(event, {
      from: new Date("2026-10-19T00:00:00Z"),
      to: new Date("2026-11-17T00:00:00Z"),
    }).map((instance) => instance.start.toISOString());
    expect(starts).toEqual([
      "2026-10-19T08:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
      "2026-11-16T09:00:00.000Z",
    ]);
  });

  test("a moved instance names the start it replaces and carries no rule of its own", () => {
    const { event } = eventOf("f0c5s1k2wq9series_20261116T090000Z");
    expect(event).toMatchObject({
      uid: "f0c5s1k2wq9series@google.com",
      recurrenceId: new Date("2026-11-16T09:00:00Z"),
      start: new Date("2026-11-16T11:00:00Z"),
      rrule: null,
      exdates: [],
    });
  });

  test("a cancelled instance names its series and start; a deleted event only its id", () => {
    expect(readGoogleEvent(item("f0c5s1k2wq9series_20261123T090000Z"), page.timeZone)).toEqual({
      kind: "cancelled",
      googleId: "f0c5s1k2wq9series_20261123T090000Z",
      instanceOf: {
        googleId: "f0c5s1k2wq9series",
        recurrenceId: new Date("2026-11-23T09:00:00Z"),
      },
    } satisfies GoogleCalendarChange);
    expect(readGoogleEvent(item("8hq2deletedevent"), page.timeZone)).toEqual({
      kind: "cancelled",
      googleId: "8hq2deletedevent",
      instanceOf: null,
    } satisfies GoogleCalendarChange);
  });

  test("an all-day event keeps its days, end exclusive, and a free one does not count as busy", () => {
    const { event } = eventOf("4n1allday");
    expect(event).toMatchObject({
      allDay: true,
      startDay: "2026-12-03",
      endDay: "2026-12-05",
      start: new Date("2026-12-03T00:00:00Z"),
      end: new Date("2026-12-05T00:00:00Z"),
      busy: false,
      timeZone: null,
    });
  });

  test("an event that names no zone takes the calendar's, and keeps its tentative status", () => {
    const { event } = eventOf("7wl3floating");
    expect(event).toMatchObject({ timeZone: "Europe/Madrid", status: "tentative" });
  });

  test("a working location is not an event, and an item without a start or UID is refused", () => {
    expect(readGoogleEvent(item("wl9home"), page.timeZone)).toBeNull();
    expect(readGoogleEvent({ id: "x", status: "confirmed", iCalUID: "x@google.com" })).toBeNull();
    expect(
      readGoogleEvent({ id: "x", status: "confirmed", start: { date: "2026-12-01" } }),
    ).toBeNull();
    expect(readGoogleEvent("not an event")).toBeNull();
  });

  test("a recurrence line cannot smuggle a second event in", () => {
    const { event } = eventOf("f0c5s1k2wq9series");
    const sneaky = readGoogleEvent(
      {
        ...item("f0c5s1k2wq9series"),
        recurrence: [
          "RRULE:FREQ=DAILY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evil",
          "RRULE:FREQ=WEEKLY",
        ],
      },
      page.timeZone,
    );
    expect(sneaky?.kind === "event" && sneaky.event.rrule).toBe("FREQ=WEEKLY");
    expect(event.uid).toBe("f0c5s1k2wq9series@google.com");
  });
});
