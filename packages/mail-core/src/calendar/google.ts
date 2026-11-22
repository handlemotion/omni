import { convert } from "html-to-text";
import { normalizeAddress } from "../addresses.ts";
import {
  CALENDAR_ATTENDEES_MAX,
  CALENDAR_DESCRIPTION_MAX,
  CALENDAR_TEXT_MAX,
  calendarText,
  httpsLink,
  meetingLinkIn,
  parseCalendar,
  type AttendeeResponse,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarPerson,
} from "./parse.ts";
import { nextDay, resolveZone } from "./zones.ts";

/**
 * One item of Google Calendar's `events.list` (API v3), read into what the calendar stores
 * (`docs/spec/calendar.md`, "Google calendars"). A live event reads as the same `CalendarEvent`
 * an invitation gives, keyed by its iCalendar `UID`, so the invitation in mail and the event in
 * Google land on one row. A cancelled item reads as a cancellation of its Google id: a deleted
 * event carries nothing else, and a cancelled instance of a series also its series and start.
 */
export type GoogleCalendarChange =
  | { kind: "event"; googleId: string; event: CalendarEvent }
  | {
      kind: "cancelled";
      googleId: string;
      /** For one cancelled instance of a series: the series' Google id and the instance's start. */
      instanceOf: { googleId: string; recurrenceId: Date } | null;
    };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOf = (value: unknown) => (typeof value === "string" ? value : null);

const SKIPPED_TYPES = new Set(["workingLocation"]);

const RESPONSES: Record<string, AttendeeResponse> = {
  needsAction: "needs_action",
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
};

interface GoogleTime {
  instant: Date;
  day: string | null;
  zone: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function timeOf(value: unknown, calendarZone: string | null) {
  if (!isObject(value)) return null;
  const date = stringOf(value.date);
  if (date && DAY.test(date)) {
    const instant = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(instant.getTime())) return null;
    return { instant, day: date, zone: null } satisfies GoogleTime;
  }
  const dateTime = stringOf(value.dateTime);
  if (!dateTime) return null;
  const instant = new Date(dateTime);
  if (Number.isNaN(instant.getTime())) return null;
  const zone = resolveZone(stringOf(value.timeZone)) ?? calendarZone;
  return { instant, day: null, zone: zone === "UTC" ? null : zone } satisfies GoogleTime;
}

function personOf(value: unknown) {
  if (!isObject(value)) return null;
  const email = stringOf(value.email)?.trim();
  if (!email || !email.includes("@") || /\s/.test(email)) return null;
  const person: CalendarPerson = {
    address: normalizeAddress(email),
    name: calendarText(value.displayName, CALENDAR_TEXT_MAX),
  };
  return person;
}

function attendeesOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  const attendees: CalendarAttendee[] = [];
  for (const item of value) {
    if (!isObject(item) || item.resource === true) continue;
    const person = personOf(item);
    if (!person || attendees.some((a) => a.address === person.address)) continue;
    attendees.push({
      ...person,
      role: item.organizer === true ? "chair" : item.optional === true ? "optional" : "required",
      response: RESPONSES[stringOf(item.responseStatus) ?? ""] ?? "needs_action",
    });
    if (attendees.length === CALENDAR_ATTENDEES_MAX) break;
  }
  return attendees;
}

function recurrenceOf(value: unknown) {
  const none = { rrule: null, exdates: [] as Date[], rdates: [] as Date[] };
  if (!Array.isArray(value)) return none;
  const lines = value
    .filter((line): line is string => typeof line === "string")
    .filter((line) => !/[\r\n]/.test(line) && /^(RRULE|EXDATE|RDATE)[:;]/i.test(line));
  if (lines.length === 0) return none;
  const parsed = parseCalendar(
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:recurrence",
      "DTSTART:20000101T000000Z",
      ...lines,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  const event = parsed.ok ? parsed.calendar.events[0] : undefined;
  if (!event) return none;
  return { rrule: event.rrule, exdates: event.exdates, rdates: event.rdates };
}

function conferenceOf(item: Json, texts: (string | null)[]) {
  const hangout = httpsLink(item.hangoutLink);
  if (hangout) return hangout;
  const entryPoints = isObject(item.conferenceData) ? item.conferenceData.entryPoints : null;
  if (Array.isArray(entryPoints)) {
    for (const entry of entryPoints) {
      if (!isObject(entry) || entry.entryPointType !== "video") continue;
      const link = httpsLink(entry.uri);
      if (link) return link;
    }
  }
  return meetingLinkIn(texts);
}

function descriptionOf(value: unknown) {
  const raw = stringOf(value)?.slice(0, DESCRIPTION_HTML_MAX);
  if (!raw) return null;
  const text = raw.includes("<") ? descriptionText(raw) : raw;
  return calendarText(text, CALENDAR_DESCRIPTION_MAX);
}

const DESCRIPTION_HTML_MAX = CALENDAR_DESCRIPTION_MAX * 4;

/**
 * The text of the HTML Google Calendar writes in a description (`<br>`, `<b>`, `<a>`, lists),
 * through a real HTML parser: no link targets, no images, entities decoded. Shown as text.
 */
export function descriptionText(html: string) {
  return convert(html.slice(0, DESCRIPTION_HTML_MAX), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "ul", options: { itemPrefix: "- " } },
    ],
  }).trim();
}

function endOf(item: Json, start: GoogleTime, calendarZone: string | null) {
  const end = timeOf(item.end, calendarZone);
  if (end && end.instant >= start.instant && (end.day === null) === (start.day === null)) {
    return end;
  }
  if (start.day) {
    const day = nextDay(start.day);
    return { instant: new Date(`${day}T00:00:00Z`), day, zone: null } satisfies GoogleTime;
  }
  return start;
}

function cancellationOf(item: Json, googleId: string, calendarZone: string | null) {
  const seriesId = stringOf(item.recurringEventId);
  const original = seriesId ? timeOf(item.originalStartTime, calendarZone) : null;
  const change: GoogleCalendarChange = {
    kind: "cancelled",
    googleId,
    instanceOf:
      seriesId && original ? { googleId: seriesId, recurrenceId: original.instant } : null,
  };
  return change;
}

/**
 * Reads one `events.list` item. `calendarZone` is the list's own `timeZone`, for an event that
 * names none. Null for an item that is not an event Omni shows (a working location) or that
 * lacks what an event needs: Google's answers are untrusted input like mail.
 */
export function readGoogleEvent(item: unknown, calendarZone: string | null = null) {
  if (!isObject(item)) return null;
  const googleId = calendarText(item.id, 1024);
  if (!googleId) return null;
  const zone = resolveZone(calendarZone);
  if (item.status === "cancelled") return cancellationOf(item, googleId, zone);
  if (SKIPPED_TYPES.has(stringOf(item.eventType) ?? "")) return null;
  const uid = calendarText(item.iCalUID, 1000);
  const start = timeOf(item.start, zone);
  if (!uid || !start) return null;
  const end = endOf(item, start, zone);
  const original = stringOf(item.recurringEventId) ? timeOf(item.originalStartTime, zone) : null;
  const recurrence = original
    ? { rrule: null, exdates: [], rdates: [] }
    : recurrenceOf(item.recurrence);
  const description = descriptionOf(item.description);
  const location = calendarText(item.location, CALENDAR_TEXT_MAX);
  const updated = stringOf(item.updated) ? new Date(String(item.updated)) : null;
  const sequence = typeof item.sequence === "number" ? Math.max(0, Math.floor(item.sequence)) : 0;
  const event: CalendarEvent = {
    uid,
    recurrenceId: original?.instant ?? null,
    sequence,
    dtstamp: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    status: item.status === "tentative" ? "tentative" : "confirmed",
    busy: item.transparency !== "transparent",
    title: calendarText(item.summary, CALENDAR_TEXT_MAX) ?? "",
    description,
    location,
    conferenceUrl: conferenceOf(item, [location, description]),
    allDay: start.day !== null,
    start: start.instant,
    end: end.instant,
    startDay: start.day,
    endDay: start.day ? end.day : null,
    timeZone: start.zone,
    ...recurrence,
    organizer: personOf(item.organizer),
    attendees: attendeesOf(item.attendees),
  };
  const change: GoogleCalendarChange = { kind: "event", googleId, event };
  return change;
}
