import { normalizeAddress } from "@omni/mail-core/addresses";
import {
  seriesEnd,
  type CalendarEvent,
  type CalendarMethod,
  type CalendarParse,
} from "@omni/mail-core/calendar";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { CalendarAttachment } from "../mail.ts";
import {
  calendarAnswers,
  calendarAttendees,
  calendarEvents,
  calendarParts,
} from "../schema/index.ts";
import { calendarOf, type Ex } from "./core.ts";

export type PartOutcome = "applied" | "stale" | "ignored" | "invalid";

/** Why a part changed nothing, as stored in `calendar_parts.reason`. */
export type PartReason =
  | "junk"
  | "too_large"
  | "unreadable"
  | "no_events"
  | "missing"
  | "unknown_event"
  | "not_organizer"
  | "not_attendee"
  | "older";

export type PartResult =
  | { status: "done_before" }
  | { status: PartOutcome; calendarId: string; reason: PartReason | null };

interface Context {
  orgId: string;
  calendarId: string;
  messageId: string;
  me: string;
  from: string;
  ownSend: boolean;
}

type Judged = { outcome: PartOutcome; reason: PartReason | null };

const APPLIED = { outcome: "applied", reason: null } satisfies Judged;
const ignored = (reason: PartReason) => ({ outcome: "ignored", reason }) satisfies Judged;
const STALE = { outcome: "stale", reason: "older" } satisfies Judged;

/** What a part found unreadable, or `missing` when its object is gone from storage. */
export type UnreadPart = {
  ok: false;
  reason: "too_large" | "unreadable" | "no_events" | "missing";
};

/**
 * Applies one `text/calendar` attachment to its inbox's calendar (`docs/spec/calendar.md`,
 * "Ingesting invitations"), in one transaction, and records what it did. A part already recorded
 * changes nothing (`done_before`), so the sweep and the arrival path may both reach it.
 */
export async function applyCalendarPart(
  db: Db,
  part: CalendarAttachment,
  parsed: CalendarParse | UnreadPart,
) {
  return db.transaction(async (tx) => {
    const calendarId = await calendarOf(tx, { id: part.mailboxId, orgId: part.orgId });
    const [claimed] = await tx
      .insert(calendarParts)
      .values({ attachmentId: part.id, orgId: part.orgId, calendarId, outcome: "invalid" })
      .onConflictDoNothing()
      .returning({ id: calendarParts.attachmentId });
    if (!claimed) return { status: "done_before" as const };

    const me = normalizeAddress(part.mailboxAddress);
    const from = normalizeAddress(part.fromAddress);
    const context: Context = {
      orgId: part.orgId,
      calendarId,
      messageId: part.messageId,
      me,
      from,
      ownSend: from === me && part.folderRoles.includes("sent"),
    };
    const onlyJunk =
      part.folderRoles.length > 0 &&
      part.folderRoles.every((role) => role === "junk" || role === "trash");
    let judged: Judged;
    let method: CalendarMethod | null = null;
    let uid: string | null = null;
    if (onlyJunk) judged = ignored("junk");
    else if (!parsed.ok) judged = { outcome: "invalid", reason: parsed.reason };
    else {
      method = parsed.calendar.method;
      uid = parsed.calendar.events[0]?.uid ?? null;
      judged = await applyEvents(tx, context, method, parsed.calendar.events);
    }
    await tx
      .update(calendarParts)
      .set({ method, uid, outcome: judged.outcome, reason: judged.reason })
      .where(eq(calendarParts.attachmentId, part.id));
    return { status: judged.outcome, calendarId, reason: judged.reason } satisfies PartResult;
  });
}

async function applyEvents(
  tx: Ex,
  context: Context,
  method: CalendarMethod,
  events: CalendarEvent[],
) {
  const ordered = events.toSorted(
    (a, b) => Number(a.recurrenceId !== null) - Number(b.recurrenceId !== null),
  );
  const results: Judged[] = [];
  for (const event of ordered) {
    results.push(
      method === "REPLY"
        ? await applyReply(tx, context, event)
        : await applyVersion(tx, context, method, event),
    );
  }
  return results.find((r) => r.outcome === "applied") ?? results[0] ?? ignored("unknown_event");
}

const eventColumns = {
  id: calendarEvents.id,
  sequence: calendarEvents.sequence,
  dtstamp: calendarEvents.dtstamp,
  organizerAddress: calendarEvents.organizerAddress,
};

type Stored = {
  id: string;
  sequence: number;
  dtstamp: Date | null;
  organizerAddress: string | null;
};

async function stored(tx: Ex, calendarId: string, uid: string, recurrenceId: Date | null) {
  const [row] = await tx
    .select(eventColumns)
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        eq(calendarEvents.uid, uid),
        recurrenceId
          ? eq(calendarEvents.recurrenceId, recurrenceId)
          : isNull(calendarEvents.recurrenceId),
      ),
    )
    .for("update");
  return (row ?? null) satisfies Stored | null;
}

function older(event: CalendarEvent, current: Stored) {
  if (event.sequence !== current.sequence) return event.sequence < current.sequence;
  if (!event.dtstamp || !current.dtstamp) return false;
  return event.dtstamp < current.dtstamp;
}

const mayChange = (context: Context, authority: Stored) =>
  context.ownSend || (authority.organizerAddress ?? "") === context.from;

async function applyVersion(
  tx: Ex,
  context: Context,
  method: CalendarMethod,
  event: CalendarEvent,
) {
  const current = await stored(tx, context.calendarId, event.uid, event.recurrenceId);
  const series = event.recurrenceId ? await stored(tx, context.calendarId, event.uid, null) : null;
  const authority = current ?? series;
  if (method === "CANCEL" && !authority) return ignored("unknown_event");
  if (authority && !mayChange(context, authority)) return ignored("not_organizer");
  if (current && older(event, current)) return STALE;
  if (current && method === "CANCEL") return cancel(tx, context, event, current);
  const values = versionValues(context, method, event, current);
  let eventId = current?.id;
  if (eventId) await tx.update(calendarEvents).set(values).where(eq(calendarEvents.id, eventId));
  else eventId = await insertEvent(tx, context, event, values);
  await syncAttendees(tx, context, eventId, event);
  return APPLIED;
}

async function cancel(tx: Ex, context: Context, event: CalendarEvent, current: Stored) {
  await tx
    .update(calendarEvents)
    .set({
      status: "cancelled",
      sequence: event.sequence,
      dtstamp: event.dtstamp,
      messageId: context.messageId,
    })
    .where(
      event.recurrenceId
        ? eq(calendarEvents.id, current.id)
        : and(eq(calendarEvents.calendarId, context.calendarId), eq(calendarEvents.uid, event.uid)),
    );
  return APPLIED;
}

function versionValues(
  context: Context,
  method: CalendarMethod,
  event: CalendarEvent,
  current: Stored | null,
) {
  const cancelling = method === "CANCEL" || event.status === "cancelled";
  return {
    sequence: event.sequence,
    dtstamp: event.dtstamp,
    status: cancelling ? ("cancelled" as const) : event.status,
    busy: event.busy,
    title: event.title,
    description: event.description,
    location: event.location,
    conferenceUrl: event.conferenceUrl,
    startsAt: event.start,
    endsAt: event.end,
    allDay: event.allDay,
    startDay: event.startDay,
    endDay: event.endDay,
    timeZone: event.timeZone,
    rrule: event.rrule,
    exdates: event.exdates,
    rdates: event.rdates,
    recursUntil: event.rrule ? seriesEnd(event) : event.end,
    organizerAddress: event.organizer?.address ?? current?.organizerAddress ?? context.from,
    organizerName: event.organizer?.name ?? null,
    messageId: context.messageId,
  };
}

async function insertEvent(
  tx: Ex,
  context: Context,
  event: CalendarEvent,
  values: ReturnType<typeof versionValues>,
) {
  const [made] = await tx
    .insert(calendarEvents)
    .values({
      ...values,
      orgId: context.orgId,
      calendarId: context.calendarId,
      uid: event.uid,
      recurrenceId: event.recurrenceId,
      source: "invite",
    })
    .returning({ id: calendarEvents.id });
  if (!made) throw new Error("calendar event insert returned nothing");
  return made.id;
}

async function syncAttendees(tx: Ex, context: Context, eventId: string, event: CalendarEvent) {
  const answers = await answersOf(tx, context.calendarId, event.uid, event.recurrenceId);
  await tx.delete(calendarAttendees).where(eq(calendarAttendees.eventId, eventId));
  if (event.attendees.length === 0) return;
  const stamp = event.dtstamp;
  await tx.insert(calendarAttendees).values(
    event.attendees.map((attendee) => {
      const own = answers.get(attendee.address);
      const theirs = own && (!stamp || own.answeredAt > stamp);
      return {
        eventId,
        orgId: context.orgId,
        address: attendee.address,
        name: attendee.name,
        role: attendee.role,
        response: theirs ? own.response : attendee.response,
        respondedAt: theirs ? own.answeredAt : stamp,
      };
    }),
  );
}

async function answersOf(tx: Ex, calendarId: string, uid: string, recurrenceId: Date | null) {
  const rows = await tx
    .select({
      address: calendarAnswers.address,
      response: calendarAnswers.response,
      answeredAt: calendarAnswers.answeredAt,
    })
    .from(calendarAnswers)
    .where(
      and(
        eq(calendarAnswers.calendarId, calendarId),
        eq(calendarAnswers.uid, uid),
        recurrenceId
          ? eq(calendarAnswers.recurrenceId, recurrenceId)
          : isNull(calendarAnswers.recurrenceId),
      ),
    );
  return new Map(rows.map((row) => [row.address, row]));
}

async function applyReply(tx: Ex, context: Context, event: CalendarEvent) {
  const responder = context.ownSend ? context.me : context.from;
  const answer = event.attendees.find((attendee) => attendee.address === responder);
  if (!answer) return ignored("not_attendee");
  const stamp = event.dtstamp ?? new Date();
  const kept = await tx
    .insert(calendarAnswers)
    .values({
      orgId: context.orgId,
      calendarId: context.calendarId,
      uid: event.uid,
      recurrenceId: event.recurrenceId,
      address: responder,
      response: answer.response,
      answeredAt: stamp,
    })
    .onConflictDoUpdate({
      target: [
        calendarAnswers.calendarId,
        calendarAnswers.uid,
        calendarAnswers.recurrenceId,
        calendarAnswers.address,
      ],
      set: { response: answer.response, answeredAt: stamp },
      setWhere: sql`${calendarAnswers.answeredAt} <= ${stamp.toISOString()}::timestamptz`,
    })
    .returning({ address: calendarAnswers.address });
  if (kept.length === 0) return STALE;
  const current = await stored(tx, context.calendarId, event.uid, event.recurrenceId);
  if (current) {
    await tx
      .update(calendarAttendees)
      .set({ response: answer.response, respondedAt: stamp })
      .where(
        and(
          eq(calendarAttendees.eventId, current.id),
          eq(calendarAttendees.address, responder),
          sql`(${calendarAttendees.respondedAt} is null or ${calendarAttendees.respondedAt} <= ${stamp.toISOString()}::timestamptz)`,
        ),
      );
  }
  return APPLIED;
}
