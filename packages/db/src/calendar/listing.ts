import { and, eq, inArray, sql } from "drizzle-orm";
import { calendarEvents, calendarMemberPrefs, calendarParts } from "../schema/index.ts";
import { calendarOf, calendarsOf, NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";
import { getEvent } from "./read.ts";

/** A calendar as one member sees it: its inbox, and their color and toggle. */
export interface MemberCalendarView {
  id: string;
  orgId: string;
  mailboxId: string;
  address: string;
  kind: string;
  color: string | null;
  hidden: boolean;
}

/**
 * The calendars of every inbox the member can open in their workspace, each made the first time
 * it is listed, with the member's own color and toggle.
 */
export async function listMemberCalendars(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
) {
  for (const mailbox of mailboxes) await calendarOf(ex, mailbox);
  const calendars = await calendarsOf(ex, mailboxes);
  const prefs = calendars.length
    ? await ex
        .select()
        .from(calendarMemberPrefs)
        .where(
          and(
            eq(calendarMemberPrefs.memberId, memberId),
            inArray(
              calendarMemberPrefs.calendarId,
              calendars.map((c) => c.id),
            ),
          ),
        )
    : [];
  const byCalendar = new Map(prefs.map((p) => [p.calendarId, p]));
  return calendars
    .map(
      (c) =>
        ({
          id: c.id,
          orgId: c.orgId,
          mailboxId: c.mailbox.id,
          address: c.mailbox.address,
          kind: c.mailbox.kind,
          color: byCalendar.get(c.id)?.color ?? null,
          hidden: byCalendar.get(c.id)?.hidden ?? false,
        }) satisfies MemberCalendarView,
    )
    .toSorted((a, b) => a.address.localeCompare(b.address));
}

/** Sets the member's own color or toggle for a calendar they can see. */
export async function setCalendarPrefs(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
  calendarId: string,
  prefs: { color?: string | null; hidden?: boolean },
) {
  const [calendar] = (await calendarsOf(ex, mailboxes)).filter((c) => c.id === calendarId);
  if (!calendar) return NOT_FOUND;
  await ex
    .insert(calendarMemberPrefs)
    .values({
      memberId,
      calendarId,
      orgId: calendar.orgId,
      color: prefs.color ?? null,
      hidden: prefs.hidden ?? false,
    })
    .onConflictDoUpdate({
      target: [calendarMemberPrefs.memberId, calendarMemberPrefs.calendarId],
      set: {
        ...(prefs.color !== undefined ? { color: prefs.color } : {}),
        ...(prefs.hidden !== undefined ? { hidden: prefs.hidden } : {}),
        updatedAt: new Date(),
      },
    });
  return { status: "ok" as const };
}

/** The calendars this member turned off. */
export async function hiddenCalendars(ex: Ex, memberId: string) {
  const rows = await ex
    .select({ calendarId: calendarMemberPrefs.calendarId })
    .from(calendarMemberPrefs)
    .where(and(eq(calendarMemberPrefs.memberId, memberId), eq(calendarMemberPrefs.hidden, true)));
  return new Set(rows.map((row) => row.calendarId));
}

/**
 * The invitations in a thread's messages, each with its event on a calendar the member can see.
 * The caller passes the attachment ids of a thread mail's door opened for the member.
 */
export async function invitesIn(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[],
  attachments: readonly { id: string; messageId: string }[],
) {
  if (attachments.length === 0) return [];
  const parts = await ex
    .select({
      attachmentId: calendarParts.attachmentId,
      calendarId: calendarParts.calendarId,
      method: calendarParts.method,
      uid: calendarParts.uid,
      outcome: calendarParts.outcome,
    })
    .from(calendarParts)
    .where(
      inArray(
        calendarParts.attachmentId,
        attachments.map((a) => a.id),
      ),
    );
  const visible = new Set((await calendarsOf(ex, mailboxes)).map((c) => c.id));
  const invites = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!part.calendarId || !part.uid || !visible.has(part.calendarId)) continue;
    const [row] = await ex
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.calendarId, part.calendarId), eq(calendarEvents.uid, part.uid)))
      .orderBy(sql`${calendarEvents.recurrenceId} asc nulls first`)
      .limit(1);
    if (!row || seen.has(`${row.id} ${part.method}`)) continue;
    seen.add(`${row.id} ${part.method}`);
    const found = await getEvent(ex, mailboxes, row.id);
    if (found.status !== "ok") continue;
    const messageId = attachments.find((a) => a.id === part.attachmentId)?.messageId ?? null;
    invites.push({ messageId, method: part.method, event: found.event });
  }
  return invites;
}
