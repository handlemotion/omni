import ICAL from "ical.js";
import type { AttendeeResponse, AttendeeRole, CalendarPerson, EventStatus } from "./parse.ts";

/** What Omni sends: an invitation or its update, an answer, or a cancellation (RFC 6047). */
export type OutgoingMethod = "REQUEST" | "REPLY" | "CANCEL";

export interface OutgoingAttendee extends CalendarPerson {
  role: AttendeeRole;
  response: AttendeeResponse;
}

export interface OutgoingEvent {
  uid: string;
  /** For one instance of a series. */
  recurrenceId: Date | null;
  sequence: number;
  dtstamp: Date;
  status: EventStatus;
  busy: boolean;
  title: string;
  description: string | null;
  location: string | null;
  conferenceUrl: string | null;
  allDay: boolean;
  start: Date;
  end: Date;
  /** `YYYY-MM-DD`, for an all-day event; `endDay` exclusive. */
  startDay: string | null;
  endDay: string | null;
  organizer: CalendarPerson;
  attendees: readonly OutgoingAttendee[];
}

const ROLES: Record<AttendeeRole, string> = {
  chair: "CHAIR",
  required: "REQ-PARTICIPANT",
  optional: "OPT-PARTICIPANT",
  none: "NON-PARTICIPANT",
};

const RESPONSES: Record<AttendeeResponse, string> = {
  needs_action: "NEEDS-ACTION",
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
  delegated: "DELEGATED",
};

const STATUSES: Record<EventStatus, string> = {
  confirmed: "CONFIRMED",
  tentative: "TENTATIVE",
  cancelled: "CANCELLED",
};

const utc = (date: Date) => ICAL.Time.fromJSDate(date, true);
const day = (value: string) => ICAL.Time.fromDateString(value);

function person(vevent: ICAL.Component, name: "organizer" | "attendee", who: CalendarPerson) {
  const property = new ICAL.Property(name);
  property.setValue(`mailto:${who.address}`);
  if (who.name) property.setParameter("cn", who.name);
  vevent.addProperty(property);
  return property;
}

function times(vevent: ICAL.Component, event: OutgoingEvent) {
  if (event.allDay && event.startDay && event.endDay) {
    vevent.addPropertyWithValue("dtstart", day(event.startDay));
    vevent.addPropertyWithValue("dtend", day(event.endDay));
  } else {
    vevent.addPropertyWithValue("dtstart", utc(event.start));
    vevent.addPropertyWithValue("dtend", utc(event.end));
  }
  if (event.recurrenceId) vevent.addPropertyWithValue("recurrence-id", utc(event.recurrenceId));
}

/**
 * The `text/calendar` body of an iMIP message. Times are written in UTC, which every calendar
 * reads without a `VTIMEZONE`; all-day events as days. A `REPLY` carries only `replying`'s
 * attendee line, as RFC 5546 asks; a `CANCEL` is the event marked cancelled.
 */
export function buildCalendar(
  method: OutgoingMethod,
  event: OutgoingEvent,
  options: { replying?: string } = {},
) {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("prodid", "-//Omni//Calendar//EN");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  calendar.addPropertyWithValue("method", method);
  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", event.uid);
  vevent.addPropertyWithValue("dtstamp", utc(event.dtstamp));
  vevent.addPropertyWithValue("sequence", event.sequence);
  times(vevent, event);
  vevent.addPropertyWithValue("summary", event.title);
  if (method !== "REPLY") {
    if (event.description) vevent.addPropertyWithValue("description", event.description);
    if (event.location) vevent.addPropertyWithValue("location", event.location);
    if (event.conferenceUrl) vevent.addPropertyWithValue("url", event.conferenceUrl);
    vevent.addPropertyWithValue("transp", event.busy ? "OPAQUE" : "TRANSPARENT");
  }
  const status = method === "CANCEL" ? "CANCELLED" : STATUSES[event.status];
  if (method !== "REPLY") vevent.addPropertyWithValue("status", status);
  person(vevent, "organizer", event.organizer);
  const listed =
    method === "REPLY"
      ? event.attendees.filter((a) => a.address === options.replying)
      : event.attendees;
  for (const attendee of listed) {
    const property = person(vevent, "attendee", attendee);
    property.setParameter("role", ROLES[attendee.role]);
    property.setParameter("partstat", RESPONSES[attendee.response]);
    if (method === "REQUEST" && attendee.address !== event.organizer.address) {
      property.setParameter("rsvp", "TRUE");
    }
  }
  calendar.addSubcomponent(vevent);
  return calendar.toString().replace(/\r?\n/g, "\r\n");
}
