import { ERROR_CODES, type CalendarEvent as WireEvent, type ErrorCode } from "@omni/contracts";
import {
  forMember,
  mailboxAudience,
  type CalendarEventView,
  type Db,
  type MemberCalendar,
} from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { errorBody } from "../errors.ts";
import type { Logger } from "../log.ts";

export const memberCalendar: (c: Context<AppEnv>) => MemberCalendar = (c) =>
  forMember(c.var.db, c.var.member.id).calendar;

export type CalendarRefusal =
  | { status: "not_found" }
  | { status: "not_organizer" }
  | { status: "not_invited" }
  | { status: "invalid_event"; field: string }
  | { status: "window_too_large"; maxDays: number }
  | { status: "slot_taken" };

const ANSWERS: Record<CalendarRefusal["status"], { code: ErrorCode; message: string }> = {
  not_found: { code: "not_found", message: "no such event or calendar, or you cannot see it" },
  not_organizer: {
    code: "not_organizer",
    message: "only the organizer changes this event; answer it instead",
  },
  not_invited: { code: "not_invited", message: "this inbox is not invited to the event" },
  invalid_event: { code: "invalid_event", message: "the event's fields do not hold together" },
  window_too_large: { code: "window_too_large", message: "read at most 62 days at a time" },
  slot_taken: { code: "slot_taken", message: "that time is no longer free; pick another" },
};

export function refused(c: Context<AppEnv>, refusal: CalendarRefusal) {
  const { code, message } = ANSWERS[refusal.status];
  const param = refusal.status === "invalid_event" ? { param: refusal.field } : {};
  return c.json(errorBody(c, code, message, param), ERROR_CODES[code].status);
}

const iso = (date: Date) => date.toISOString();

export const wireEvent = (event: CalendarEventView) =>
  ({
    id: event.id,
    calendarId: event.calendarId,
    mailboxId: event.mailboxId,
    uid: event.uid,
    recurrenceId: event.recurrenceId ? iso(event.recurrenceId) : null,
    recurring: event.recurring,
    source: event.source,
    status: event.status,
    busy: event.busy,
    title: event.title,
    description: event.description,
    location: event.location,
    conferenceUrl: event.conferenceUrl,
    start: iso(event.start),
    end: iso(event.end),
    allDay: event.allDay,
    startDay: event.startDay,
    endDay: event.endDay,
    timeZone: event.timeZone,
    organizer: event.organizer,
    organizing: event.organizing,
    attendees: event.attendees,
    myResponse: event.myResponse,
  }) satisfies WireEvent;

/**
 * Tells the members of each calendar's inbox that its events changed. After the response, and
 * never failing it: a missed announcement only delays a refresh.
 */
export async function announceCalendars(
  env: Env,
  db: Db,
  log: Logger,
  calendars: readonly { calendarId: string; mailboxId: string }[],
) {
  if (calendars.length === 0) return;
  try {
    const audience = await mailboxAudience(db, [...new Set(calendars.map((c) => c.mailboxId))]);
    const byOrg = Map.groupBy(audience, (row) => row.orgId);
    for (const [orgId, rows] of byOrg) {
      const mailboxIds = new Set(rows.map((row) => row.mailboxId));
      const calendarIds = [
        ...new Set(calendars.filter((c) => mailboxIds.has(c.mailboxId)).map((c) => c.calendarId)),
      ];
      const memberIds = [...new Set(rows.map((row) => row.memberId))];
      if (calendarIds.length === 0 || memberIds.length === 0) continue;
      const stub = env.REALTIME.get(env.REALTIME.idFromName(orgId));
      await stub.broadcast(memberIds, { type: "calendar.changed", calendarIds });
    }
  } catch (error) {
    log.warn("calendar.announce_failed", { error });
  }
}
