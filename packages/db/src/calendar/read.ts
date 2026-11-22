import { expandSeries } from "@omni/mail-core/calendar";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { calendarAttendees, calendarEvents } from "../schema/index.ts";
import { calendarsOf, NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";

/** The longest window one read expands. */
export const CALENDAR_WINDOW_MAX_DAYS = 62;
const DAY_MS = 86_400_000;

export type CalendarResponse = (typeof calendarAttendees.$inferSelect)["response"];

export interface CalendarEventAttendee {
  address: string;
  name: string | null;
  role: (typeof calendarAttendees.$inferSelect)["role"];
  response: CalendarResponse;
}

/** One event, or one instance of a series, as a person's calendar shows it. */
export interface CalendarEventView {
  /** The row: a series' instances share it, and `recurrenceId` tells them apart. */
  id: string;
  orgId: string;
  calendarId: string;
  mailboxId: string;
  uid: string;
  /** The instance's original start, for an instance of a series; null for a single event. */
  recurrenceId: Date | null;
  recurring: boolean;
  source: (typeof calendarEvents.$inferSelect)["source"];
  status: (typeof calendarEvents.$inferSelect)["status"];
  busy: boolean;
  title: string;
  description: string | null;
  location: string | null;
  conferenceUrl: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  startDay: string | null;
  endDay: string | null;
  timeZone: string | null;
  organizer: { address: string; name: string | null } | null;
  /** The inbox organizes it. */
  organizing: boolean;
  attendees: CalendarEventAttendee[];
  /** The inbox's own answer; null when it is not among the attendees. */
  myResponse: CalendarResponse | null;
  /** The message that last set it, for its thread (mail's door decides who opens it). */
  messageId: string | null;
}

type Row = typeof calendarEvents.$inferSelect;

export type WindowTooLarge = { status: "window_too_large"; maxDays: number };

/** Every visible event overlapping `[from, to)`, soonest first, cancelled ones left out. */
export async function listEvents(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[],
  window: { from: Date; to: Date; calendarIds?: readonly string[] },
) {
  if (
    !(window.to > window.from) ||
    window.to.getTime() - window.from.getTime() > CALENDAR_WINDOW_MAX_DAYS * DAY_MS
  ) {
    return { status: "window_too_large", maxDays: CALENDAR_WINDOW_MAX_DAYS } as WindowTooLarge;
  }
  const calendars = (await calendarsOf(ex, mailboxes)).filter(
    (c) => !window.calendarIds || window.calendarIds.includes(c.id),
  );
  if (calendars.length === 0) return { status: "ok" as const, events: [] as CalendarEventView[] };
  const ids = calendars.map((c) => c.id);
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const rows = await ex
    .select()
    .from(calendarEvents)
    .where(
      and(
        inArray(calendarEvents.calendarId, ids),
        lt(calendarEvents.startsAt, sql`${to}::timestamptz`),
        or(
          and(isNull(calendarEvents.rrule), gt(calendarEvents.endsAt, sql`${from}::timestamptz`)),
          and(
            isNotNull(calendarEvents.rrule),
            or(
              isNull(calendarEvents.recursUntil),
              gt(calendarEvents.recursUntil, sql`${from}::timestamptz`),
            ),
          ),
        ),
      ),
    );
  const series = rows.filter((row) => row.rrule && row.status !== "cancelled");
  const replaced = await changedInstances(ex, series);
  const people = await attendeesOf(
    ex,
    rows.map((row) => row.id),
  );
  const byCalendar = new Map(calendars.map((c) => [c.id, c]));
  const events: CalendarEventView[] = [];
  for (const row of rows) {
    const calendar = byCalendar.get(row.calendarId);
    if (!calendar || row.status === "cancelled") continue;
    const base = viewOf(row, calendar.mailbox, people.get(row.id) ?? []);
    if (!row.rrule) {
      events.push(base);
      continue;
    }
    const skip = replaced.get(`${row.calendarId} ${row.uid}`) ?? new Set();
    for (const instance of expandSeries(seriesOf(row), window)) {
      if (skip.has(instance.recurrenceId.getTime())) continue;
      events.push({
        ...base,
        recurrenceId: instance.recurrenceId,
        start: instance.start,
        end: instance.end,
        startDay: instance.startDay,
        endDay: instance.endDay,
      });
    }
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
  return { status: "ok" as const, events };
}

/** One visible event (a series is its first instance), or `not_found`. */
export async function getEvent(ex: Ex, mailboxes: readonly VisibleMailbox[], id: string) {
  const [row] = await ex.select().from(calendarEvents).where(eq(calendarEvents.id, id));
  if (!row) return NOT_FOUND;
  const [calendar] = (await calendarsOf(ex, mailboxes)).filter((c) => c.id === row.calendarId);
  if (!calendar || calendar.orgId !== row.orgId) return NOT_FOUND;
  const people = await attendeesOf(ex, [row.id]);
  return { status: "ok" as const, event: viewOf(row, calendar.mailbox, people.get(row.id) ?? []) };
}

const seriesOf = (row: Row) => ({
  start: row.startsAt,
  end: row.endsAt,
  allDay: row.allDay,
  startDay: row.startDay,
  endDay: row.endDay,
  timeZone: row.timeZone,
  rrule: row.rrule,
  exdates: row.exdates,
  rdates: row.rdates,
});

async function changedInstances(ex: Ex, series: Row[]) {
  const replaced = new Map<string, Set<number>>();
  if (series.length === 0) return replaced;
  const rows = await ex
    .select({
      calendarId: calendarEvents.calendarId,
      uid: calendarEvents.uid,
      recurrenceId: calendarEvents.recurrenceId,
    })
    .from(calendarEvents)
    .where(
      and(
        inArray(calendarEvents.calendarId, [...new Set(series.map((s) => s.calendarId))]),
        inArray(calendarEvents.uid, [...new Set(series.map((s) => s.uid))]),
        isNotNull(calendarEvents.recurrenceId),
      ),
    );
  for (const row of rows) {
    if (!row.recurrenceId) continue;
    const key = `${row.calendarId} ${row.uid}`;
    const set = replaced.get(key) ?? new Set<number>();
    set.add(row.recurrenceId.getTime());
    replaced.set(key, set);
  }
  return replaced;
}

async function attendeesOf(ex: Ex, eventIds: string[]) {
  const byEvent = new Map<string, CalendarEventAttendee[]>();
  if (eventIds.length === 0) return byEvent;
  const rows = await ex
    .select()
    .from(calendarAttendees)
    .where(inArray(calendarAttendees.eventId, [...new Set(eventIds)]))
    .orderBy(calendarAttendees.address);
  for (const row of rows) {
    const list = byEvent.get(row.eventId) ?? [];
    list.push({ address: row.address, name: row.name, role: row.role, response: row.response });
    byEvent.set(row.eventId, list);
  }
  return byEvent;
}

function viewOf(row: Row, mailbox: VisibleMailbox, attendees: CalendarEventAttendee[]) {
  const me = mailbox.address.toLowerCase();
  return {
    id: row.id,
    orgId: row.orgId,
    calendarId: row.calendarId,
    mailboxId: mailbox.id,
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    recurring: row.rrule !== null || row.recurrenceId !== null,
    source: row.source,
    status: row.status,
    busy: row.busy,
    title: row.title,
    description: row.description,
    location: row.location,
    conferenceUrl: row.conferenceUrl,
    start: row.startsAt,
    end: row.endsAt,
    allDay: row.allDay,
    startDay: row.startDay,
    endDay: row.endDay,
    timeZone: row.timeZone,
    organizer: row.organizerAddress
      ? { address: row.organizerAddress, name: row.organizerName }
      : null,
    organizing: row.organizerAddress === me,
    attendees,
    myResponse: attendees.find((a) => a.address === me)?.response ?? null,
    messageId: row.messageId,
  } satisfies CalendarEventView;
}
