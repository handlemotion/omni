import { normalizeAddress } from "@omni/mail-core/addresses";
import type { Db } from "./client.ts";
import { calendarsOf, type VisibleMailbox } from "./calendar/core.ts";
import { getEvent, listEvents } from "./calendar/read.ts";
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
      listEvents(db, await visible(), window),
    event: async (id: string) => getEvent(db, await visible(), id),
  };
}

/**
 * The calendar's member door (`docs/spec/calendar.md`): a calendar is reached exactly as its
 * inbox is, through mail's door, so a member sees the events of the inboxes they can open in
 * their workspace and nothing else.
 */
export function memberCalendar(db: Db, memberId: string) {
  return calendarDoor(db, () => memberMail(db, memberId).listMailboxes());
}

/** The same across every workspace the person belongs to, or only `scopeOrgId`'s. */
export function userCalendar(db: Db, userId: string, scopeOrgId?: string | null) {
  return calendarDoor(db, () => userMail(db, userId, scopeOrgId).listMailboxes());
}

export type MemberCalendar = ReturnType<typeof memberCalendar>;
