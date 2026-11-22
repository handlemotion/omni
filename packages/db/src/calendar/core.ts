import { and, eq, inArray } from "drizzle-orm";
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

/** The inbox's calendar, made the first time it is needed. Safe to race: one row per inbox. */
export async function calendarOf(ex: Ex, mailbox: { id: string; orgId: string }) {
  await ex
    .insert(calendarCalendars)
    .values({ orgId: mailbox.orgId, mailboxId: mailbox.id })
    .onConflictDoNothing({ target: calendarCalendars.mailboxId });
  const [row] = await ex
    .select({ id: calendarCalendars.id })
    .from(calendarCalendars)
    .where(
      and(eq(calendarCalendars.mailboxId, mailbox.id), eq(calendarCalendars.orgId, mailbox.orgId)),
    );
  if (!row) throw new Error(`no calendar for mailbox ${mailbox.id}`);
  return row.id;
}

/** The calendars of these inboxes that exist, by inbox. Makes none. */
export async function calendarsOf(ex: Ex, mailboxes: readonly VisibleMailbox[]) {
  if (mailboxes.length === 0) return [];
  const rows = await ex
    .select({
      id: calendarCalendars.id,
      orgId: calendarCalendars.orgId,
      mailboxId: calendarCalendars.mailboxId,
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
