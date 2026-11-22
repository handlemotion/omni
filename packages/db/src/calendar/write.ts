import { normalizeAddress } from "@omni/mail-core/addresses";
import type { OutgoingEvent } from "@omni/mail-core/calendar";
import { and, eq, ne } from "drizzle-orm";
import { calendarAnswers, calendarAttendees, calendarEvents } from "../schema/index.ts";
import { calendarsOf, NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";
import type { CalendarResponse } from "./read.ts";
import { answerSubject, queueCalendarMail, type Sender } from "./sends.ts";

/** Who writes: the member, the inboxes they can open, and the request that asked. */
export interface Writer {
  memberId: string;
  requestId: string | null;
  mailboxes: readonly VisibleMailbox[];
}

export const CALENDAR_GUESTS_MAX = 100;
const TITLE_MAX = 500;
const TEXT_MAX = 20_000;
const LONGEST_MS = 14 * 86_400_000;

export type NotOrganizer = { status: "not_organizer" };
export type NotInvited = { status: "not_invited" };
export type InvalidEvent = { status: "invalid_event"; field: string };

export interface OwnEventInput {
  calendarId: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  /** The zone the person made it in (their browser's), for the words of the invitation. */
  timeZone?: string | null;
  location?: string | null;
  description?: string | null;
  conferenceUrl?: string | null;
  busy?: boolean;
  guests?: { address: string; name?: string | null }[];
}

export type OwnEventPatch = Partial<Omit<OwnEventInput, "calendarId">>;

type Row = typeof calendarEvents.$inferSelect;
type Attendee = typeof calendarAttendees.$inferSelect;

async function located(tx: Ex, writer: Writer, eventId: string) {
  const [row] = await tx
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, eventId))
    .for("update");
  if (!row) return null;
  const [calendar] = (await calendarsOf(tx, writer.mailboxes)).filter(
    (c) => c.id === row.calendarId && c.orgId === row.orgId,
  );
  if (!calendar) return null;
  const attendees = await tx
    .select()
    .from(calendarAttendees)
    .where(eq(calendarAttendees.eventId, row.id))
    .orderBy(calendarAttendees.address);
  return { row, mailbox: calendar.mailbox, attendees };
}

const senderOf = (writer: Writer, mailbox: VisibleMailbox) =>
  ({
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    address: normalizeAddress(mailbox.address),
    memberId: writer.memberId,
    requestId: writer.requestId,
  }) satisfies Sender;

function outgoing(row: Row, attendees: readonly Guest[], dtstamp: Date) {
  const event: OutgoingEvent = {
    uid: row.uid,
    recurrenceId: row.recurrenceId,
    sequence: row.sequence,
    dtstamp,
    status: row.status,
    busy: row.busy,
    title: row.title,
    description: row.description,
    location: row.location,
    conferenceUrl: row.conferenceUrl,
    allDay: row.allDay,
    start: row.startsAt,
    end: row.endsAt,
    startDay: row.startDay,
    endDay: row.endDay,
    organizer: { address: row.organizerAddress ?? "", name: row.organizerName },
    attendees: attendees.map((a) => ({
      address: a.address,
      name: a.name,
      role: a.role,
      response: a.response,
    })),
  };
  return event;
}

/**
 * Answers an invitation as the inbox it reached: the answer is kept (`calendar_answers`), the
 * attendee shows it at once, and one `REPLY` goes to the organizer in the invitation's thread. The
 * same answer again changes and sends nothing, so a retried request sends no second reply.
 */
export async function answerEvent(
  tx: Ex,
  writer: Writer,
  eventId: string,
  response: Exclude<CalendarResponse, "needs_action" | "delegated">,
) {
  const found = await located(tx, writer, eventId);
  if (!found) return NOT_FOUND;
  const { row, mailbox, attendees } = found;
  const me = normalizeAddress(mailbox.address);
  const mine = attendees.find((a) => a.address === me);
  if (!mine || row.organizerAddress === me || !row.organizerAddress) {
    return { status: "not_invited" } satisfies NotInvited;
  }
  if (mine.response === response) return { status: "ok" as const, changed: false };
  const now = new Date();
  await tx
    .insert(calendarAnswers)
    .values({
      orgId: row.orgId,
      calendarId: row.calendarId,
      uid: row.uid,
      recurrenceId: row.recurrenceId,
      address: me,
      response,
      answeredAt: now,
    })
    .onConflictDoUpdate({
      target: [
        calendarAnswers.calendarId,
        calendarAnswers.uid,
        calendarAnswers.recurrenceId,
        calendarAnswers.address,
      ],
      set: { response, answeredAt: now },
    });
  await tx
    .update(calendarAttendees)
    .set({ response, respondedAt: now })
    .where(and(eq(calendarAttendees.eventId, row.id), eq(calendarAttendees.address, me)));
  const answered = attendees.map((a) => (a.address === me ? { ...a, response } : a));
  await queueCalendarMail(tx, senderOf(writer, mailbox), {
    key: `calendar:reply:${row.id}:${now.toISOString()}`,
    method: "REPLY",
    event: outgoing(row, answered, now),
    to: [row.organizerAddress],
    zone: row.timeZone,
    subject: answerSubject(response, row.title),
    replying: me,
    answer: response,
    replyTo: row.messageId ? { messageId: row.messageId } : null,
  });
  return { status: "ok" as const, changed: true };
}

const invalidAt = (field: string) => ({ status: "invalid_event", field }) satisfies InvalidEvent;

function badTimes(input: OwnEventPatch) {
  if (input.title !== undefined && (!input.title.trim() || input.title.length > TITLE_MAX)) {
    return "title";
  }
  if (!input.start || !input.end) return null;
  const length = input.end.getTime() - input.start.getTime();
  return length > 0 && length <= LONGEST_MS ? null : "end";
}

function badDetail(input: OwnEventPatch) {
  if ((input.description?.length ?? 0) > TEXT_MAX) return "description";
  if ((input.location?.length ?? 0) > TITLE_MAX) return "location";
  if (input.conferenceUrl && !/^https:\/\//i.test(input.conferenceUrl)) return "conferenceUrl";
  const guests = input.guests ?? [];
  if (guests.length > CALENDAR_GUESTS_MAX) return "guests";
  return guests.some((g) => !/^[^\s@]+@[^\s@]+$/.test(g.address)) ? "guests" : null;
}

function checked(input: OwnEventPatch) {
  const field = badTimes(input) ?? badDetail(input);
  return field ? invalidAt(field) : null;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

function fieldsOf(input: OwnEventPatch, current?: Row) {
  const allDay = input.allDay ?? current?.allDay ?? false;
  const start = input.start ?? current?.startsAt;
  const end = input.end ?? current?.endsAt;
  return {
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(start ? { startsAt: start, startDay: allDay ? dayOf(start) : null } : {}),
    ...(end ? { endsAt: end, recursUntil: end, endDay: allDay ? dayOf(end) : null } : {}),
    allDay,
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.conferenceUrl !== undefined ? { conferenceUrl: input.conferenceUrl } : {}),
    ...(input.busy !== undefined ? { busy: input.busy } : {}),
  };
}

type Guest = Pick<Attendee, "eventId" | "orgId" | "address" | "name" | "role" | "response"> & {
  respondedAt?: Date | null;
};

function guestRows(
  row: Pick<Row, "id" | "orgId">,
  me: string,
  guests: readonly { address: string; name?: string | null }[],
) {
  const rows: Guest[] = [
    {
      eventId: row.id,
      orgId: row.orgId,
      address: me,
      name: null,
      role: "chair",
      response: "accepted",
    },
  ];
  const seen = new Set([me]);
  for (const guest of guests) {
    const address = normalizeAddress(guest.address);
    if (seen.has(address)) continue;
    seen.add(address);
    rows.push({
      eventId: row.id,
      orgId: row.orgId,
      address,
      name: guest.name ?? null,
      role: "required",
      response: "needs_action",
    });
  }
  return rows;
}

const others = (attendees: readonly Pick<Guest, "address">[], me: string) =>
  attendees.map((a) => a.address).filter((address) => address !== me);

/** Makes an event on the calendar of an inbox the member can open, and invites its guests. */
export async function createOwnEvent(tx: Ex, writer: Writer, input: OwnEventInput) {
  const invalid = checked(input);
  if (invalid) return invalid;
  const [calendar] = (await calendarsOf(tx, writer.mailboxes)).filter(
    (c) => c.id === input.calendarId,
  );
  if (!calendar) return NOT_FOUND;
  const me = normalizeAddress(calendar.mailbox.address);
  const now = new Date();
  const [row] = await tx
    .insert(calendarEvents)
    .values({
      orgId: calendar.orgId,
      calendarId: calendar.id,
      uid: `${crypto.randomUUID()}@${me.split("@")[1] ?? "omni"}`,
      sequence: 0,
      dtstamp: now,
      source: "omni",
      title: input.title.trim(),
      startsAt: input.start,
      endsAt: input.end,
      ...fieldsOf(input),
      organizerAddress: me,
      createdByMemberId: writer.memberId,
    })
    .returning();
  if (!row) throw new Error("calendar event insert returned nothing");
  const attendees = guestRows(row, me, input.guests ?? []);
  if ((input.guests ?? []).length > 0) await tx.insert(calendarAttendees).values(attendees);
  await queueCalendarMail(tx, senderOf(writer, calendar.mailbox), {
    key: `calendar:request:${row.id}:0`,
    method: "REQUEST",
    event: outgoing(row, attendees, now),
    to: others(attendees, me),
    zone: row.timeZone,
    subject: `Invitation: ${row.title}`,
  });
  return { status: "ok" as const, eventId: row.id };
}

async function editable(tx: Ex, writer: Writer, eventId: string) {
  const found = await located(tx, writer, eventId);
  if (!found || found.row.status === "cancelled") return NOT_FOUND;
  const me = normalizeAddress(found.mailbox.address);
  if (found.row.source !== "omni" || found.row.organizerAddress !== me) {
    return { status: "not_organizer" } satisfies NotOrganizer;
  }
  return { status: "ok" as const, ...found, me };
}

/**
 * Changes an event made in Omni. A change guests see sends them an update with a higher
 * sequence; a new time asks them again; a guest taken off is sent a cancellation.
 */
export async function updateOwnEvent(
  tx: Ex,
  writer: Writer,
  eventId: string,
  patch: OwnEventPatch,
) {
  const found = await editable(tx, writer, eventId);
  if (found.status !== "ok") return found;
  const { row, mailbox, attendees, me } = found;
  const merged = { ...patch, start: patch.start ?? row.startsAt, end: patch.end ?? row.endsAt };
  const invalid = checked(merged);
  if (invalid) return invalid;
  const now = new Date();
  const moved =
    merged.start.getTime() !== row.startsAt.getTime() ||
    merged.end.getTime() !== row.endsAt.getTime();
  const [updated] = await tx
    .update(calendarEvents)
    .set({ ...fieldsOf(patch, row), sequence: row.sequence + 1, dtstamp: now })
    .where(eq(calendarEvents.id, row.id))
    .returning();
  if (!updated) return NOT_FOUND;
  let next: Guest[] = attendees;
  if (patch.guests) {
    next = guestRows(row, me, patch.guests).map(
      (wanted) => attendees.find((a) => a.address === wanted.address) ?? wanted,
    );
    await tx.delete(calendarAttendees).where(eq(calendarAttendees.eventId, row.id));
    if (next.length > 1) await tx.insert(calendarAttendees).values(next);
  }
  if (moved) {
    await tx
      .update(calendarAttendees)
      .set({ response: "needs_action", respondedAt: null })
      .where(and(eq(calendarAttendees.eventId, row.id), ne(calendarAttendees.address, me)));
    next = next.map((a) =>
      a.address === me ? a : { ...a, response: "needs_action", respondedAt: null },
    );
  }
  const sender = senderOf(writer, mailbox);
  await queueCalendarMail(tx, sender, {
    key: `calendar:request:${row.id}:${updated.sequence}`,
    method: "REQUEST",
    event: outgoing(updated, next, now),
    to: others(next, me),
    zone: updated.timeZone,
    subject: `Updated invitation: ${updated.title}`,
  });
  const removed = others(attendees, me).filter((a) => !next.some((n) => n.address === a));
  await queueCalendarMail(tx, sender, {
    key: `calendar:cancel:${row.id}:${updated.sequence}:removed`,
    method: "CANCEL",
    event: outgoing(updated, next, now),
    to: removed,
    zone: updated.timeZone,
    subject: `Cancelled: ${updated.title}`,
  });
  return { status: "ok" as const, eventId: row.id };
}

/** Cancels an event made in Omni: it leaves the calendar, and its guests are sent a cancellation. */
export async function deleteOwnEvent(tx: Ex, writer: Writer, eventId: string) {
  const found = await editable(tx, writer, eventId);
  if (found.status !== "ok") return found;
  const { row, mailbox, attendees, me } = found;
  const now = new Date();
  const [cancelled] = await tx
    .update(calendarEvents)
    .set({ status: "cancelled", sequence: row.sequence + 1, dtstamp: now })
    .where(eq(calendarEvents.id, row.id))
    .returning();
  if (!cancelled) return NOT_FOUND;
  await queueCalendarMail(tx, senderOf(writer, mailbox), {
    key: `calendar:cancel:${row.id}:${cancelled.sequence}`,
    method: "CANCEL",
    event: outgoing(cancelled, attendees, now),
    to: others(attendees, me),
    zone: cancelled.timeZone,
    subject: `Cancelled: ${cancelled.title}`,
  });
  return { status: "ok" as const, eventId: row.id };
}
