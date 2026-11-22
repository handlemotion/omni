import { normalizeAddress } from "@omni/mail-core/addresses";
import type { Db } from "./client.ts";
import { calendarsOf, type Ex, type VisibleMailbox } from "./calendar/core.ts";
import {
  hiddenCalendars,
  invitesIn,
  listMemberCalendars,
  setCalendarPrefs,
} from "./calendar/listing.ts";
import {
  answerEvent,
  createOwnEvent,
  deleteOwnEvent,
  updateOwnEvent,
  type OwnEventInput,
  type OwnEventPatch,
  type Writer,
} from "./calendar/write.ts";
import { getEvent, listEvents, windowRefused } from "./calendar/read.ts";
import { memberMail, userMail } from "./mail.ts";

export type { VisibleMailbox } from "./calendar/core.ts";
export {
  applyCalendarPart,
  type PartOutcome,
  type PartReason,
  type PartResult,
  type UnreadPart,
} from "./calendar/ingest.ts";
export {
  CALENDAR_WINDOW_MAX_DAYS,
  type CalendarEventAttendee,
  type CalendarEventView,
  type CalendarResponse,
  type WindowTooLarge,
} from "./calendar/read.ts";
export {
  advanceCalendarSweep,
  CALENDAR_SETTLE_MS,
  CALENDAR_SWEEP_BATCH,
  calendarArrivals,
  calendarSweepPage,
} from "./calendar/sweep.ts";

type Mailboxes = () => Promise<VisibleMailbox[]>;

function calendarDoor(db: Db, mailboxes: Mailboxes) {
  const visible = async () =>
    (await mailboxes()).map((m) => ({ ...m, address: normalizeAddress(m.address) }));
  return {
    calendars: async () => {
      const found = await calendarsOf(db, await visible());
      return found.map(({ id, orgId, mailbox }) => ({
        id,
        orgId,
        mailboxId: mailbox.id,
        address: mailbox.address,
        kind: mailbox.kind,
      }));
    },
    events: async (window: { from: Date; to: Date; calendarIds?: readonly string[] }) =>
      windowRefused(window) ?? listEvents(db, await visible(), window),
    event: (id: string) => getEvent(db, visible, id),
  };
}

/**
 * The calendar's member door (`docs/spec/calendar.md`): a calendar is reached exactly as its
 * inbox is, through mail's door, so a member sees the events of the inboxes they can open in
 * their workspace and nothing else. Writes run in one transaction with the mail they send.
 */
export function memberCalendar(db: Db, memberId: string) {
  const mail = memberMail(db, memberId);
  const mailboxes = async () =>
    (await mail.listMailboxes()).map((m) => ({ ...m, address: normalizeAddress(m.address) }));
  const write = async <T>(
    requestId: string | null,
    run: (tx: Ex, writer: Writer) => Promise<T>,
  ) => {
    const writer: Writer = { memberId, requestId, mailboxes: await mailboxes() };
    return db.transaction((tx) => run(tx, writer));
  };
  const read = calendarDoor(db, mailboxes);
  return {
    ...read,
    calendars: async () => listMemberCalendars(db, memberId, await mailboxes()),
    setPrefs: async (calendarId: string, prefs: { color?: string | null; hidden?: boolean }) =>
      setCalendarPrefs(db, memberId, await mailboxes(), calendarId, prefs),
    events: async (window: { from: Date; to: Date; calendarIds?: readonly string[] }) => {
      const refusal = windowRefused(window);
      if (refusal) return refusal;
      const [visible, hidden] = await Promise.all([
        mailboxes(),
        window.calendarIds ? undefined : hiddenCalendars(db, memberId),
      ]);
      return listEvents(db, visible, { ...window, ...(hidden ? { hidden } : {}) });
    },
    invites: async (threadId: string) => {
      const thread = await mail.getThread(threadId);
      if (!thread) return { status: "not_found" as const };
      const attachments = thread.messages.flatMap((m) =>
        m.attachments.map((a) => ({ id: a.id, messageId: m.id })),
      );
      return {
        status: "ok" as const,
        invites: await invitesIn(db, await mailboxes(), attachments),
      };
    },
    answer: (eventId: string, response: Answer, requestId: string | null = null) =>
      write(requestId, (tx, writer) => answerEvent(tx, writer, eventId, response)),
    createEvent: (input: OwnEventInput, requestId: string | null = null) =>
      write(requestId, (tx, writer) => createOwnEvent(tx, writer, input)),
    updateEvent: (eventId: string, patch: OwnEventPatch, requestId: string | null = null) =>
      write(requestId, (tx, writer) => updateOwnEvent(tx, writer, eventId, patch)),
    deleteEvent: (eventId: string, requestId: string | null = null) =>
      write(requestId, (tx, writer) => deleteOwnEvent(tx, writer, eventId)),
  };
}

type Answer = Parameters<typeof answerEvent>[3];

/** The same across every workspace the person belongs to, or only `scopeOrgId`'s. */
export function userCalendar(db: Db, userId: string, scopeOrgId?: string | null) {
  return calendarDoor(db, () => userMail(db, userId, scopeOrgId).listMailboxes());
}

export type MemberCalendar = ReturnType<typeof memberCalendar>;
export type { MemberCalendarView } from "./calendar/listing.ts";
export {
  CALENDAR_GUESTS_MAX,
  type InvalidEvent,
  type NotInvited,
  type NotOrganizer,
  type OwnEventInput,
  type OwnEventPatch,
} from "./calendar/write.ts";
