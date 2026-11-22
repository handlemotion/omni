import { expandSeries } from "@omni/mail-core/calendar";
import { and, eq, inArray } from "drizzle-orm";
import { calendarCalendars, calendarEvents } from "../schema/index.ts";
import { NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";
import { getEvent, listEvents, type CalendarEventView } from "./read.ts";

/** Which meeting: an event's row (as the calendar shows it) or its iCalendar `UID`. */
export type OccurrenceRef = { id: string } | { uid: string };

/** How long before its start an event counts as on now: Record shows from five minutes before. */
export const OCCURRENCE_LEAD_MS = 5 * 60_000;

/**
 * One meeting on the person's calendars: a single event, or one instance of a series by its
 * original start (`recurrenceId`), moved or not. Found by the iCalendar identity, so the same
 * meeting on two inboxes, from an invitation or from Google, and before or after a re-sync is the
 * same answer. `not_found` for a series without an instance, a cancelled one, or one the person
 * cannot see.
 */
export async function findOccurrence(
  ex: Ex,
  mailboxes: () => Promise<readonly VisibleMailbox[]>,
  ref: OccurrenceRef,
  recurrenceId: Date | null,
) {
  const visible = await mailboxes();
  const uid = "uid" in ref ? ref.uid : await uidOf(ex, visible, ref.id);
  if (!uid) return NOT_FOUND;
  const rows = await rowsOf(ex, visible, uid);
  const preferred = "id" in ref ? ref.id : null;
  rows.sort((a, b) => Number(b.row.id === preferred) - Number(a.row.id === preferred));
  const byMailbox = new Map(visible.map((m) => [m.id, m]));
  for (const { row, mailboxId } of rows) {
    const mailbox = byMailbox.get(mailboxId);
    if (!mailbox) continue;
    const found = occurrenceIn(row, rows, recurrenceId);
    if (found === "cancelled") return NOT_FOUND;
    if (!found) continue;
    const viewed = await getEvent(ex, [mailbox], found.row.id);
    if (viewed.status !== "ok") continue;
    return { status: "ok" as const, event: { ...viewed.event, ...found.instance } };
  }
  return NOT_FOUND;
}

type Found = Awaited<ReturnType<typeof rowsOf>>[number];

function occurrenceIn(base: Found["row"], rows: Found[], recurrenceId: Date | null) {
  const mine = rows.filter((r) => r.row.calendarId === base.calendarId).map((r) => r.row);
  if (recurrenceId === null) {
    const single = mine.find((r) => r.rrule === null && r.recurrenceId === null);
    if (!single) return null;
    return single.status === "cancelled" ? "cancelled" : { row: single, instance: {} };
  }
  const at = recurrenceId.getTime();
  const changed = mine.find((r) => r.recurrenceId?.getTime() === at);
  if (changed) return changed.status === "cancelled" ? "cancelled" : { row: changed, instance: {} };
  const series = mine.find((r) => r.rrule !== null && r.recurrenceId === null);
  if (!series) return null;
  if (series.status === "cancelled") return "cancelled";
  const [instance] = expandSeries(
    {
      start: series.startsAt,
      end: series.endsAt,
      allDay: series.allDay,
      startDay: series.startDay,
      endDay: series.endDay,
      timeZone: series.timeZone,
      rrule: series.rrule,
      exdates: series.exdates,
      rdates: series.rdates,
    },
    { from: recurrenceId, to: new Date(at + 1) },
  ).filter((i) => i.recurrenceId.getTime() === at);
  return instance ? { row: series, instance } : null;
}

async function uidOf(ex: Ex, visible: readonly VisibleMailbox[], id: string) {
  const found = await getEvent(ex, visible, id);
  return found.status === "ok" ? found.event.uid : null;
}

async function rowsOf(ex: Ex, visible: readonly VisibleMailbox[], uid: string) {
  if (visible.length === 0) return [];
  const rows = await ex
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
        eq(calendarEvents.uid, uid),
        inArray(
          calendarCalendars.mailboxId,
          visible.map((m) => m.id),
        ),
      ),
    );
  const orgOf = new Map(visible.map((m) => [m.id, m.orgId]));
  return rows.filter((r) => orgOf.get(r.mailboxId) === r.row.orgId);
}

/**
 * The meeting the person is in at `at`: a timed event on any of their calendars, hidden ones
 * too, that is on (from five minutes before its start to its end), not cancelled, not declined,
 * and has someone else in it or a call link. Of several, the one that started last; the same
 * meeting on two inboxes counts once. Null when there is none.
 */
export async function occurrenceAt(ex: Ex, mailboxes: readonly VisibleMailbox[], at: Date) {
  const listed = await listEvents(ex, mailboxes, {
    from: at,
    to: new Date(at.getTime() + OCCURRENCE_LEAD_MS),
  });
  if (listed.status !== "ok") return null;
  const own = new Set(mailboxes.map((m) => m.address.toLowerCase()));
  const meetings = listed.events.filter(
    (e) =>
      !e.allDay &&
      e.status !== "cancelled" &&
      e.myResponse !== "declined" &&
      (e.conferenceUrl !== null || othersIn(e, own) > 0),
  );
  const [best] = meetings.toSorted(
    (a, b) =>
      b.start.getTime() - a.start.getTime() ||
      othersIn(b, own) - othersIn(a, own) ||
      a.id.localeCompare(b.id),
  );
  return best ?? null;
}

const othersIn = (event: CalendarEventView, own: ReadonlySet<string>) =>
  new Set(
    [...event.attendees.map((a) => a.address), event.organizer?.address]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase())
      .filter((a) => !own.has(a)),
  ).size;
