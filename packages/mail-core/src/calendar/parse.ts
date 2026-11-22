import ICAL from "ical.js";
import { normalizeAddress } from "../addresses.ts";
import { dayOf, instantOf, nextDay, resolveZone, type WallClock } from "./zones.ts";

/** The most bytes of `text/calendar` read from one part; a bigger one is refused. */
export const CALENDAR_PART_MAX_BYTES = 256 * 1024;
/** Longer descriptions are cut, never refused. */
export const CALENDAR_DESCRIPTION_MAX = 20_000;
/** More attendees are dropped, never refused. */
export const CALENDAR_ATTENDEES_MAX = 200;
/** A series plus its changed instances: more VEVENTs in one part are dropped. */
export const CALENDAR_EVENTS_PER_PART_MAX = 100;
/** Titles, locations and names are cut to this. */
export const CALENDAR_TEXT_MAX = 500;
const TEXT_MAX = CALENDAR_TEXT_MAX;

export type CalendarMethod = "REQUEST" | "REPLY" | "CANCEL" | "PUBLISH";
export type EventStatus = "confirmed" | "tentative" | "cancelled";
export type AttendeeRole = "chair" | "required" | "optional" | "none";
export type AttendeeResponse = "needs_action" | "accepted" | "declined" | "tentative" | "delegated";

export interface CalendarPerson {
  /** Normalized as mail stores addresses (`normalizeAddress`). */
  address: string;
  name: string | null;
}

export interface CalendarAttendee extends CalendarPerson {
  role: AttendeeRole;
  response: AttendeeResponse;
}

/** One VEVENT, as plain data. Instants are UTC; the zone is what the organizer's calendar used. */
export interface CalendarEvent {
  uid: string;
  /** The original start of the one instance this changes, for a changed instance of a series. */
  recurrenceId: Date | null;
  sequence: number;
  dtstamp: Date | null;
  status: EventStatus;
  /** Counts as busy (`TRANSP:OPAQUE`, the default). */
  busy: boolean;
  title: string;
  description: string | null;
  location: string | null;
  /** An `https:` link to join a call, from the invitation's conference fields or its text. */
  conferenceUrl: string | null;
  allDay: boolean;
  /** For an all-day event, midnight UTC of its first day. */
  start: Date;
  /** Exclusive. For an all-day event, midnight UTC of the day after its last. */
  end: Date;
  /** `YYYY-MM-DD` for an all-day event, else null. */
  startDay: string | null;
  /** Exclusive `YYYY-MM-DD` for an all-day event, else null. */
  endDay: string | null;
  /**
   * The IANA zone its times are in, for expanding a series at its local hour. Null for UTC, a
   * floating time, or a zone known only by the file's `VTIMEZONE` (expanded at a fixed offset).
   */
  timeZone: string | null;
  /** The `RRULE` value (`FREQ=WEEKLY;BYDAY=MO`), on a series. */
  rrule: string | null;
  exdates: Date[];
  rdates: Date[];
  organizer: CalendarPerson | null;
  attendees: CalendarAttendee[];
}

export interface ParsedCalendar {
  method: CalendarMethod;
  events: CalendarEvent[];
}

export type CalendarParse =
  | { ok: true; calendar: ParsedCalendar }
  | { ok: false; reason: "too_large" | "unreadable" | "no_events" };

const refused = (reason: Extract<CalendarParse, { ok: false }>["reason"]) =>
  ({ ok: false, reason }) satisfies CalendarParse;

const METHODS = new Set<CalendarMethod>(["REQUEST", "REPLY", "CANCEL", "PUBLISH"]);

/**
 * Parses one `text/calendar` part (RFC 5545, as iMIP sends it, RFC 6047). Untrusted input: sizes
 * are capped, text is plain, and only `https:` links come out. A method other than these four
 * (`COUNTER`, `REFRESH`, `ADD`) reads as `PUBLISH`, which changes no one's answer.
 */
export function parseCalendar(text: string) {
  if (new TextEncoder().encode(text).length > CALENDAR_PART_MAX_BYTES) {
    return refused("too_large");
  }
  let root: ICAL.Component;
  try {
    const parsed = ICAL.parse(text.replace(/^﻿/, ""));
    const first = (Array.isArray(parsed[0]) ? parsed[0] : parsed) as unknown[];
    root = new ICAL.Component(first as never);
  } catch {
    return refused("unreadable");
  }
  if (root.name !== "vcalendar") return refused("unreadable");
  const declared = String(root.getFirstPropertyValue("method") ?? "PUBLISH").toUpperCase();
  const method = (METHODS.has(declared as CalendarMethod) ? declared : "PUBLISH") as CalendarMethod;
  const zones = new Map(
    root
      .getAllSubcomponents("vtimezone")
      .map((zone) => [String(zone.getFirstPropertyValue("tzid") ?? ""), zone]),
  );
  const events: CalendarEvent[] = [];
  for (const vevent of root.getAllSubcomponents("vevent").slice(0, CALENDAR_EVENTS_PER_PART_MAX)) {
    try {
      const event = readEvent(vevent, zones, method);
      if (event) events.push(event);
    } catch {}
  }
  if (events.length === 0) return refused("no_events");
  return { ok: true, calendar: { method, events } } satisfies CalendarParse;
}

type Zones = Map<string, ICAL.Component>;

interface ReadTime {
  instant: Date;
  allDay: boolean;
  day: string | null;
  zone: string | null;
}

function clockOf(time: ICAL.Time) {
  const clock: WallClock = {
    year: time.year,
    month: time.month,
    day: time.day,
    hour: time.isDate ? 0 : time.hour,
    minute: time.isDate ? 0 : time.minute,
    second: time.isDate ? 0 : time.second,
  };
  return clock;
}

function readTime(property: ICAL.Property | null, zones: Zones) {
  if (!property) return null;
  const time = property.getFirstValue() as ICAL.Time | null;
  if (!time || typeof time !== "object" || !("year" in time)) return null satisfies ReadTime | null;
  return timeOf(time, String(property.getParameter("tzid") ?? ""), zones);
}

function timeOf(time: ICAL.Time, tzid: string, zones: Zones) {
  const read = (instant: Date, zone: string | null) =>
    ({
      instant,
      allDay: false,
      day: null,
      zone,
    }) satisfies ReadTime;
  const clock = clockOf(time);
  if (time.isDate) {
    const day = dayOf(clock);
    const allDay: ReadTime = {
      instant: new Date(`${day}T00:00:00Z`),
      allDay: true,
      day,
      zone: null,
    };
    return allDay;
  }
  if (time.zone?.tzid === "UTC" || time.toString().endsWith("Z")) {
    return read(instantOf(clock, "UTC"), null);
  }
  if (!tzid) return read(instantOf(clock, "UTC"), null);
  const defined = zones.get(tzid);
  const zone = resolveZone(tzid) ?? resolveZone(locationOf(defined));
  if (zone) return read(instantOf(clock, zone), zone);
  if (defined) {
    const local = time.clone();
    local.zone = new ICAL.Timezone(defined);
    return read(new Date(local.toUnixTime() * 1000), null);
  }
  return read(instantOf(clock, "UTC"), null);
}

const locationOf = (zone: ICAL.Component | undefined) =>
  zone ? String(zone.getFirstPropertyValue("x-lic-location") ?? "") : null;

function readEvent(vevent: ICAL.Component, zones: Zones, method: CalendarMethod) {
  const uid = calendarText(vevent.getFirstPropertyValue("uid"), 1000);
  const start = readTime(vevent.getFirstProperty("dtstart"), zones);
  if (!uid || !start) return null;
  const end = endOf(vevent, start, zones);
  const recurrence = readTime(vevent.getFirstProperty("recurrence-id"), zones);
  const rrule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  const status = statusOf(vevent, method);
  const description = calendarText(
    vevent.getFirstPropertyValue("description"),
    CALENDAR_DESCRIPTION_MAX,
  );
  const location = calendarText(vevent.getFirstPropertyValue("location"), TEXT_MAX);
  return {
    uid,
    recurrenceId: recurrence?.instant ?? null,
    sequence: Math.max(0, Number(vevent.getFirstPropertyValue("sequence") ?? 0) || 0),
    dtstamp: readTime(vevent.getFirstProperty("dtstamp"), zones)?.instant ?? null,
    status,
    busy:
      String(vevent.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase() !== "TRANSPARENT",
    title: calendarText(vevent.getFirstPropertyValue("summary"), TEXT_MAX) ?? "",
    description,
    location,
    conferenceUrl: conferenceOf(vevent, [location, description]),
    allDay: start.allDay,
    start: start.instant,
    end: end.instant,
    startDay: start.day,
    endDay: start.allDay ? end.day : null,
    timeZone: start.zone,
    rrule: rrule && !recurrence ? rrule.toString() : null,
    exdates: datesOf(vevent, "exdate", zones),
    rdates: datesOf(vevent, "rdate", zones),
    organizer: personOf(vevent.getFirstProperty("organizer")),
    attendees: vevent
      .getAllProperties("attendee")
      .filter((p) => {
        const kind = String(p.getParameter("cutype") ?? "INDIVIDUAL").toUpperCase();
        return kind !== "ROOM" && kind !== "RESOURCE";
      })
      .map(attendeeOf)
      .filter((a): a is CalendarAttendee => a !== null)
      .filter((a, i, all) => all.findIndex((b) => b.address === a.address) === i)
      .slice(0, CALENDAR_ATTENDEES_MAX),
  } satisfies CalendarEvent;
}

function endOf(vevent: ICAL.Component, start: ReadTime, zones: Zones) {
  const dayEnd = (day: string) =>
    ({
      instant: new Date(`${day}T00:00:00Z`),
      allDay: true,
      day,
      zone: null,
    }) satisfies ReadTime;
  const end = readTime(vevent.getFirstProperty("dtend"), zones);
  if (end && end.instant >= start.instant && end.allDay === start.allDay) return end;
  const duration = vevent.getFirstPropertyValue("duration") as ICAL.Duration | null;
  if (duration && typeof duration === "object" && "toSeconds" in duration) {
    const seconds = Math.max(0, duration.toSeconds());
    if (start.allDay && start.day) {
      const days = Math.max(1, Math.round(seconds / 86_400));
      return dayEnd(nextDay(start.day, days));
    }
    const later: ReadTime = {
      ...start,
      instant: new Date(start.instant.getTime() + seconds * 1000),
    };
    return later;
  }
  if (start.allDay && start.day) {
    return dayEnd(nextDay(start.day));
  }
  return start;
}

const STATUSES: Record<string, EventStatus> = { CANCELLED: "cancelled", TENTATIVE: "tentative" };

function statusOf(vevent: ICAL.Component, method: CalendarMethod) {
  const status = String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase();
  const found: EventStatus = method === "CANCEL" ? "cancelled" : (STATUSES[status] ?? "confirmed");
  return found;
}

function datesOf(vevent: ICAL.Component, name: "exdate" | "rdate", zones: Zones) {
  const dates: Date[] = [];
  for (const property of vevent.getAllProperties(name)) {
    const tzid = String(property.getParameter("tzid") ?? "");
    for (const value of property.getValues()) {
      if (value && typeof value === "object" && "year" in value) {
        dates.push(timeOf(value as ICAL.Time, tzid, zones).instant);
      }
    }
  }
  return dates.slice(0, 1000);
}

function addressOf(value: unknown) {
  const raw = String(value ?? "").trim();
  const address = raw.replace(/^mailto:/i, "");
  if (!address.includes("@") || /\s/.test(address)) return null;
  return normalizeAddress(address);
}

function personOf(property: ICAL.Property | null) {
  if (!property) return null satisfies CalendarPerson | null;
  const address = addressOf(property.getFirstValue());
  if (!address) return null;
  const person: CalendarPerson = {
    address,
    name: calendarText(property.getParameter("cn"), TEXT_MAX),
  };
  return person;
}

const ROLES: Record<string, AttendeeRole> = {
  CHAIR: "chair",
  "REQ-PARTICIPANT": "required",
  "OPT-PARTICIPANT": "optional",
  "NON-PARTICIPANT": "none",
};

const RESPONSES: Record<string, AttendeeResponse> = {
  "NEEDS-ACTION": "needs_action",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  DELEGATED: "delegated",
};

function attendeeOf(property: ICAL.Property) {
  const person = personOf(property);
  if (!person) return null;
  const attendee: CalendarAttendee = {
    ...person,
    role: ROLES[String(property.getParameter("role") ?? "").toUpperCase()] ?? "required",
    response:
      RESPONSES[String(property.getParameter("partstat") ?? "").toUpperCase()] ?? "needs_action",
  };
  return attendee;
}

const CONFERENCE_PROPERTIES = [
  "conference",
  "x-google-conference",
  "x-microsoft-skypeteamsmeetingurl",
  "x-microsoft-onlinemeetingconflink",
  "url",
];

const MEETING_LINK =
  /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w-]+\.zoom\.us\/[jw]\/[^\s<>"')]+|zoom\.us\/[jw]\/[^\s<>"')]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')]+|teams\.live\.com\/meet\/[^\s<>"')]+|[\w-]+\.webex\.com\/[^\s<>"')]+|whereby\.com\/[^\s<>"')]+|meet\.jit\.si\/[^\s<>"')]+|app\.gather\.town\/[^\s<>"')]+)/i;

function conferenceOf(vevent: ICAL.Component, texts: (string | null)[]) {
  for (const name of CONFERENCE_PROPERTIES) {
    for (const property of vevent.getAllProperties(name)) {
      const link = httpsLink(property.getFirstValue());
      if (link) return link;
    }
  }
  return meetingLinkIn(texts);
}

/** The first call link (Meet, Zoom, Teams, Webex, Whereby, Jitsi, Gather) in these texts. */
export function meetingLinkIn(texts: (string | null)[]) {
  for (const text of texts) {
    const found = text?.match(MEETING_LINK)?.[0];
    if (found) return httpsLink(found);
  }
  return null;
}

/** `value` as an `https:` URL of at most 2,000 characters, or null. */
export function httpsLink(value: unknown) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" ? url.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** Plain text without NULs, trimmed and cut to `max`; null when empty. */
export function calendarText(value: unknown, max: number) {
  if (value === null || value === undefined) return null;
  const text = String(value).replaceAll("\0", "").trim();
  return text ? text.slice(0, max) : null;
}
