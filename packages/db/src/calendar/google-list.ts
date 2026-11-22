import type { GoogleCalendarEntry } from "@omni/mail-core/calendar";
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { calendarCalendars } from "../schema/index.ts";
import { CALENDAR_KEY, makeOwnCalendars } from "./core.ts";

/**
 * Saves a Gmail inbox's Google calendar list (`docs/spec/calendar.md`, "Google calendars"): the
 * primary calendar is the inbox's own, which takes Google's colour; every other one is a
 * calendar of the inbox, added the first time it is listed and renamed or recoloured as Google
 * says; one the list no longer has is retired with its events and each member's prefs. Safe to
 * run twice, and in any order with the sync of the calendars it keeps. Says how many calendars
 * it added, which it retired, and whether it renamed or recoloured any.
 */
export async function saveGoogleCalendarList(
  db: Db,
  mailbox: { id: string; orgId: string },
  calendars: readonly GoogleCalendarEntry[],
) {
  return db.transaction(async (tx) => {
    await makeOwnCalendars(tx, [mailbox]);
    const ofMailbox = and(
      eq(calendarCalendars.mailboxId, mailbox.id),
      eq(calendarCalendars.orgId, mailbox.orgId),
    );
    const before = await tx
      .select({
        googleId: calendarCalendars.googleId,
        name: calendarCalendars.name,
        color: calendarCalendars.color,
      })
      .from(calendarCalendars)
      .where(ofMailbox);
    const known = new Map(before.map((row) => [row.googleId, row]));
    const primary = calendars.find((c) => c.primary);
    const own = known.get(null);
    let updated = primary !== undefined && own !== undefined && own.color !== primary.color;
    if (primary) {
      await tx
        .update(calendarCalendars)
        .set({ color: primary.color })
        .where(and(ofMailbox, isNull(calendarCalendars.googleId)));
    }
    const others = calendars.filter((c) => !c.primary);
    for (const c of others) {
      const was = known.get(c.googleId);
      if (was && (was.name !== c.name || was.color !== c.color)) updated = true;
    }
    if (others.length > 0) {
      await tx
        .insert(calendarCalendars)
        .values(
          others.map((c) => ({
            orgId: mailbox.orgId,
            mailboxId: mailbox.id,
            googleId: c.googleId,
            name: c.name,
            color: c.color,
          })),
        )
        .onConflictDoUpdate({
          target: CALENDAR_KEY,
          set: { name: sql`excluded.name`, color: sql`excluded.color` },
          setWhere: eq(calendarCalendars.orgId, mailbox.orgId),
        });
    }
    const retired = await tx
      .delete(calendarCalendars)
      .where(
        and(
          ofMailbox,
          isNotNull(calendarCalendars.googleId),
          ...(others.length > 0
            ? [
                notInArray(
                  calendarCalendars.googleId,
                  others.map((c) => c.googleId),
                ),
              ]
            : []),
        ),
      )
      .returning({ id: calendarCalendars.id });
    return {
      added: others.filter((c) => !known.has(c.googleId)).length,
      retired: retired.map((row) => row.id),
      updated,
    };
  });
}
