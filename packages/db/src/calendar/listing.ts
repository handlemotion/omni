import { and, eq, inArray, sql } from "drizzle-orm";
import { calendarEvents, calendarMemberPrefs, calendarParts } from "../schema/index.ts";
import { calendarsOf, makeOwnCalendars, NOT_FOUND, type Ex, type VisibleMailbox } from "./core.ts";
import { getEvent } from "./read.ts";

/**
 * A calendar as one member sees it: its inbox, its name (null for the inbox's own, named after
 * the inbox), whether it is read only (a Google calendar), and their color and toggle. The color
 * is theirs, else Google's.
 */
export interface MemberCalendarView {
  id: string;
  orgId: string;
  mailboxId: string;
  address: string;
  kind: string;
  name: string | null;
  readOnly: boolean;
  color: string | null;
  hidden: boolean;
}

/**
 * The calendars of every inbox the member can open in their workspace, each made the first time
 * it is listed, with the member's own color and toggle. The calendars and the member's prefs are
 * read at once; only inboxes with no calendar yet cost a write, all of them in one.
 */
export async function listMemberCalendars(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
) {
  const [existing, prefs] = await Promise.all([
    calendarsOf(ex, mailboxes),
    ex.select().from(calendarMemberPrefs).where(eq(calendarMemberPrefs.memberId, memberId)),
  ]);
  const made = new Set(existing.filter((c) => c.googleId === null).map((c) => c.mailboxId));
  const missing = mailboxes.filter((m) => !made.has(m.id));
  const calendars = missing.length ? await ensureCalendars(ex, mailboxes, missing) : existing;
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
          name: c.name,
          readOnly: c.googleId !== null,
          color: byCalendar.get(c.id)?.color ?? c.color,
          hidden: byCalendar.get(c.id)?.hidden ?? false,
        }) satisfies MemberCalendarView,
    )
    .toSorted(
      (a, b) =>
        a.address.localeCompare(b.address) ||
        Number(a.readOnly) - Number(b.readOnly) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id),
    );
}

async function ensureCalendars(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[],
  missing: readonly VisibleMailbox[],
) {
  await makeOwnCalendars(ex, missing);
  return calendarsOf(ex, mailboxes);
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
 * The caller passes the attachment ids of a thread mail's door opened for the member. A
 * thread's parts and their events are read in a fixed number of round trips, however many.
 */
export async function invitesIn(
  ex: Ex,
  mailboxes: readonly VisibleMailbox[],
  attachments: readonly { id: string; messageId: string }[],
) {
  if (attachments.length === 0) return [];
  const [parts, calendars] = await Promise.all([
    ex
      .select({
        attachmentId: calendarParts.attachmentId,
        calendarId: calendarParts.calendarId,
        method: calendarParts.method,
        uid: calendarParts.uid,
      })
      .from(calendarParts)
      .where(
        inArray(
          calendarParts.attachmentId,
          attachments.map((a) => a.id),
        ),
      ),
    calendarsOf(ex, mailboxes),
  ]);
  const visible = new Set(calendars.map((c) => c.id));
  const shown = parts.flatMap((part) =>
    part.calendarId && part.uid && visible.has(part.calendarId)
      ? [{ ...part, calendarId: part.calendarId, uid: part.uid }]
      : [],
  );
  if (shown.length === 0) return [];
  const firsts = await firstRowsOf(ex, shown);
  const found = await Promise.all(
    [...new Set(firsts.values())].map((id) => getEvent(ex, mailboxes, id)),
  );
  const events = new Map(
    found.flatMap((one) => (one.status === "ok" ? [[one.event.id, one.event] as const] : [])),
  );
  const invites = [];
  const seen = new Set<string>();
  for (const part of shown) {
    const id = firsts.get(`${part.calendarId} ${part.uid}`);
    if (!id || seen.has(`${id} ${part.method}`)) continue;
    seen.add(`${id} ${part.method}`);
    const event = events.get(id);
    if (!event) continue;
    const messageId = attachments.find((a) => a.id === part.attachmentId)?.messageId ?? null;
    invites.push({ messageId, method: part.method, event });
  }
  return invites;
}

async function firstRowsOf(ex: Ex, parts: readonly { calendarId: string; uid: string }[]) {
  const rows = await ex
    .selectDistinctOn([calendarEvents.calendarId, calendarEvents.uid], {
      id: calendarEvents.id,
      calendarId: calendarEvents.calendarId,
      uid: calendarEvents.uid,
    })
    .from(calendarEvents)
    .where(
      and(
        inArray(calendarEvents.calendarId, [...new Set(parts.map((p) => p.calendarId))]),
        inArray(calendarEvents.uid, [...new Set(parts.map((p) => p.uid))]),
      ),
    )
    .orderBy(
      calendarEvents.calendarId,
      calendarEvents.uid,
      sql`${calendarEvents.recurrenceId} asc nulls first`,
      calendarEvents.id,
    );
  return new Map(rows.map((row) => [`${row.calendarId} ${row.uid}`, row.id]));
}
