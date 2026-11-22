import { expandSeries } from "@omni/mail-core/calendar";
import { and, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { calendarAttendees, calendarCalendars, calendarEvents } from "../schema/index.ts";
import { NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";

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

/** Whether a read of `[from, to)` is refused before it touches the database. */
export const windowRefused = (window: { from: Date; to: Date }) =>
  !(window.to > window.from) ||
  window.to.getTime() - window.from.getTime() > CALENDAR_WINDOW_MAX_DAYS * DAY_MS
    ? ({ status: "window_too_large", maxDays: CALENDAR_WINDOW_MAX_DAYS } satisfies WindowTooLarge)
    : null;

/**
 * Every visible event overlapping `[from, to)`, soonest first, cancelled ones left out: on the
 * inboxes' calendars, only `calendarIds` when given, none of `hidden`. The calendars are joined
 * in the events' read, and the series' changed instances read beside their attendees, so a
 * window costs two round trips after the inboxes.
 */
export async function listEvents(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[],
  window: {
    from: Date;
    to: Date;
    calendarIds?: readonly string[];
    hidden?: ReadonlySet<string>;
  },
) {
  const refusal = windowRefused(window);
  if (refusal) return refusal;
  const none = { status: "ok" as const, events: [] as CalendarEventView[] };
  if (mailboxes.length === 0 || window.calendarIds?.length === 0) return none;
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  const found = await ex
    .select({ row: calendarEvents, mailboxId: calendarCalendars.mailboxId })
    .from(calendarEvents)
    .innerJoin(
      calendarCalendars,
      and(
        eq(calendarCalendars.id, calendarEvents.calendarId),
        eq(calendarCalendars.orgId, calendarEvents.orgId),
      ),
    )
    .where(
      and(
        inArray(
          calendarCalendars.mailboxId,
          mailboxes.map((m) => m.id),
        ),
        window.calendarIds
          ? inArray(calendarEvents.calendarId, [...window.calendarIds])
          : undefined,
        window.hidden?.size ? notInArray(calendarEvents.calendarId, [...window.hidden]) : undefined,
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
  const byMailbox = new Map(mailboxes.map((m) => [m.id, m]));
  const rows = found.flatMap(({ row, mailboxId }) => {
    const mailbox = byMailbox.get(mailboxId);
    return mailbox && mailbox.orgId === row.orgId && row.status !== "cancelled"
      ? [{ row, mailbox }]
      : [];
  });
  const [replaced, people] = await Promise.all([
    changedInstances(
      ex,
      rows.flatMap(({ row }) => (row.rrule ? [row] : [])),
    ),
    attendeesOf(
      ex,
      rows.map(({ row }) => row.id),
    ),
  ]);
  const events: CalendarEventView[] = [];
  for (const { row, mailbox } of rows) {
    const base = viewOf(row, mailbox, people.get(row.id) ?? []);
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

/**
 * One visible event (a series is its first instance), or `not_found`. The inboxes, the row with
 * its calendar and its attendees are read at once; attendees of a row the person cannot see are
 * dropped unread.
 */
export async function getEvent(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[] | (() => Promise<readonly VisibleMailbox[]>),
  id: string,
) {
  const [visible, [found], people] = await Promise.all([
    typeof mailboxes === "function" ? mailboxes() : mailboxes,
    ex
      .select({ row: calendarEvents, mailboxId: calendarCalendars.mailboxId })
      .from(calendarEvents)
      .innerJoin(
        calendarCalendars,
        and(
          eq(calendarCalendars.id, calendarEvents.calendarId),
          eq(calendarCalendars.orgId, calendarEvents.orgId),
        ),
      )
      .where(eq(calendarEvents.id, id)),
    attendeesOf(ex, [id]),
  ]);
  if (!found) return NOT_FOUND;
  const mailbox = visible.find((m) => m.id === found.mailboxId);
  if (!mailbox || mailbox.orgId !== found.row.orgId) return NOT_FOUND;
  return {
    status: "ok" as const,
    event: viewOf(found.row, mailbox, people.get(id) ?? []),
  };
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
