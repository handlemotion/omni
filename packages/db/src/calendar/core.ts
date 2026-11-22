import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { calendarCalendars } from "../schema/index.ts";

/** A Drizzle database or a transaction on one. */
export type Ex = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NotFound = { status: "not_found" };
export const NOT_FOUND = { status: "not_found" } as const;

/** An inbox the person can open: a calendar's access is its inbox's. */
export interface VisibleMailbox {
  id: string;
  orgId: string;
  address: string;
  kind: string;
}

/** The key of an inbox's calendars: its own has no Google id, so there is one per inbox. */
export const CALENDAR_KEY = [calendarCalendars.mailboxId, calendarCalendars.googleId];

/** Makes the inboxes' own calendars that do not exist yet. Safe to race. */
export async function makeOwnCalendars(
  ex: Ex,
  mailboxes: readonly { id: string; orgId: string }[],
) {
  if (mailboxes.length === 0) return;
  await ex
    .insert(calendarCalendars)
    .values(mailboxes.map((m) => ({ orgId: m.orgId, mailboxId: m.id })))
    .onConflictDoNothing({ target: CALENDAR_KEY });
}

/** The inbox's own calendar, made the first time it is needed. Safe to race: one per inbox. */
export async function calendarOf(ex: Ex, mailbox: { id: string; orgId: string }) {
  await makeOwnCalendars(ex, [mailbox]);
  const [row] = await ex
    .select({ id: calendarCalendars.id })
    .from(calendarCalendars)
    .where(
      and(
        eq(calendarCalendars.mailboxId, mailbox.id),
        eq(calendarCalendars.orgId, mailbox.orgId),
        isNull(calendarCalendars.googleId),
      ),
    );
  if (!row) throw new Error(`no calendar for mailbox ${mailbox.id}`);
  return row.id;
}

/**
 * The calendars of these inboxes that exist, own and Google's. Makes none. A Google calendar
 * (`googleId` set) is read only: nothing Omni makes lands on it.
 */
export async function calendarsOf(ex: Ex, mailboxes: readonly VisibleMailbox[]) {
  if (mailboxes.length === 0) return [];
  const rows = await ex
    .select({
      id: calendarCalendars.id,
      orgId: calendarCalendars.orgId,
      mailboxId: calendarCalendars.mailboxId,
      googleId: calendarCalendars.googleId,
      name: calendarCalendars.name,
      color: calendarCalendars.color,
    })
    .from(calendarCalendars)
    .where(
      inArray(
        calendarCalendars.mailboxId,
        mailboxes.map((m) => m.id),
      ),
    );
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  return rows.flatMap((row) => {
    const mailbox = byId.get(row.mailboxId);
    return mailbox && mailbox.orgId === row.orgId ? [{ ...row, mailbox }] : [];
  });
}

/** The inboxes' own calendars that exist: the ones Omni writes to. */
export async function ownCalendarsOf(ex: Ex, mailboxes: readonly VisibleMailbox[]) {
  return (await calendarsOf(ex, mailboxes)).filter((c) => c.googleId === null);
}
