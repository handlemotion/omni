import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { calendarAttachments, calendarAttachmentsOf, type CalendarAttachment } from "../mail.ts";
import { calendarParts, calendarSweep } from "../schema/index.ts";

const SWEEP = "invitations";

/**
 * How long an attachment waits before the sweep reads it and moves past it. A part committed late
 * (its transaction began earlier) is still ahead of the cursor; fresh arrivals do not wait, they
 * come through `calendarArrivals`.
 */
export const CALENDAR_SETTLE_MS = 2 * 60_000;
/** Parts one sweep page holds. */
export const CALENDAR_SWEEP_BATCH = 200;

/**
 * The sweep's next page: calendar attachments after its cursor, settled, oldest first, without
 * the ones already applied. `last` is where the page ends, for `advanceCalendarSweep` once every
 * part in it was applied. A fresh install, or emptied calendar tables, start at the oldest mail.
 */
export async function calendarSweepPage(db: Db, options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const [cursor] = await db.select().from(calendarSweep).where(eq(calendarSweep.name, SWEEP));
  const page = await calendarAttachments(db, {
    after: cursor ? { at: cursor.cursorAt, id: cursor.cursorId } : null,
    before: new Date(now.getTime() - CALENDAR_SETTLE_MS),
    limit: options.limit ?? CALENDAR_SWEEP_BATCH,
  });
  const last = page.at(-1);
  return {
    parts: await unapplied(db, page),
    last: last ? { at: last.createdAt, id: last.id } : null,
  };
}

/** Moves the sweep past `last`. Never backwards: two sweeps at once both move it forward. */
export async function advanceCalendarSweep(db: Db, last: { at: Date; id: string }) {
  await db
    .insert(calendarSweep)
    .values({ name: SWEEP, cursorAt: last.at, cursorId: last.id })
    .onConflictDoUpdate({
      target: calendarSweep.name,
      set: { cursorAt: last.at, cursorId: last.id, updatedAt: new Date() },
      setWhere: sql`(${calendarSweep.cursorAt}, ${calendarSweep.cursorId}) < (${last.at.toISOString()}::timestamptz, ${last.id})`,
    });
}

/** The calendar parts these just-arrived messages brought that are not applied yet. */
export async function calendarArrivals(db: Db, messageIds: readonly string[]) {
  return unapplied(db, await calendarAttachmentsOf(db, messageIds));
}

async function unapplied(db: Db, parts: CalendarAttachment[]) {
  if (parts.length === 0) return parts;
  const done = await db
    .select({ id: calendarParts.attachmentId })
    .from(calendarParts)
    .where(
      inArray(
        calendarParts.attachmentId,
        parts.map((part) => part.id),
      ),
    );
  const seen = new Set(done.map((row) => row.id));
  return parts.filter((part) => !seen.has(part.id));
}
