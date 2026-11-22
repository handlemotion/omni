import { describe, expect, test } from "vitest";
import { buildCalendar, type OutgoingEvent } from "./build.ts";
import { parseCalendar } from "./parse.ts";

const event: OutgoingEvent = {
  uid: "01a2-kickoff@studio.example",
  recurrenceId: null,
  sequence: 2,
  dtstamp: new Date("2026-11-22T10:00:00Z"),
  status: "confirmed",
  busy: true,
  title: "Kickoff, with Acme; and a comma",
  description: "Agenda:\nscope, dates",
  location: "Calle Mayor 1",
  conferenceUrl: "https://meet.google.com/abc-defg-hij",
  allDay: false,
  start: new Date("2026-11-24T15:30:00Z"),
  end: new Date("2026-11-24T16:15:00Z"),
  startDay: null,
  endDay: null,
  organizer: { address: "rodrigo@studio.example", name: "Rodrigo" },
  attendees: [
    { address: "rodrigo@studio.example", name: "Rodrigo", role: "chair", response: "accepted" },
    { address: "ana@acme.example", name: "Ana Ruiz", role: "required", response: "needs_action" },
  ],
};

function reparsed(text: string) {
  const parsed = parseCalendar(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.calendar;
}

describe("buildCalendar", () => {
  test("an invitation reads back as the same event, punctuation and line breaks included", () => {
    const text = buildCalendar("REQUEST", event);
    expect(text).toContain("\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
    const { method, events } = reparsed(text);
    expect(method).toBe("REQUEST");
    expect(events[0]).toMatchObject({
      uid: event.uid,
      sequence: 2,
      title: event.title,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      conferenceUrl: event.conferenceUrl,
      organizer: event.organizer,
      attendees: event.attendees,
    });
  });

  test("a reply carries only the replying attendee's line, with their answer", () => {
    const answered = {
      ...event,
      attendees: event.attendees.map((a) =>
        a.address === "ana@acme.example" ? { ...a, response: "declined" as const } : a,
      ),
    };
    const { method, events } = reparsed(
      buildCalendar("REPLY", answered, { replying: "ana@acme.example" }),
    );
    expect(method).toBe("REPLY");
    expect(events[0]?.attendees).toEqual([
      { address: "ana@acme.example", name: "Ana Ruiz", role: "required", response: "declined" },
    ]);
    expect(events[0]?.description).toBeNull();
  });

  test("a cancellation reads back cancelled, and an all-day event as days", () => {
    const allDay = {
      ...event,
      allDay: true,
      startDay: "2026-12-03",
      endDay: "2026-12-05",
      start: new Date("2026-12-03T00:00:00Z"),
      end: new Date("2026-12-05T00:00:00Z"),
    };
    const { events } = reparsed(buildCalendar("CANCEL", allDay));
    expect(events[0]).toMatchObject({
      status: "cancelled",
      allDay: true,
      startDay: "2026-12-03",
      endDay: "2026-12-05",
    });
  });
});
