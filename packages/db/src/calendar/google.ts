import type { CalendarEvent, GoogleCalendarChange } from "@omni/mail-core/calendar";
import { seriesEnd } from "@omni/mail-core/calendar";
import { and, asc, eq, inArray, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  calendarCalendars,
  calendarEvents,
  calendarGoogleSync,
  calendarParts,
} from "../schema/index.ts";
import { makeOwnCalendars, type Ex } from "./core.ts";
import { older, stored, syncAttendees, type Stored } from "./ingest.ts";

/**
 * A Gmail inbox's calendar, claimed for one Google sync pass, with where the last one stopped.
 * `googleId` is the Google calendar it shows; null for the inbox's own, which shows the primary.
 */
export interface GoogleSyncClaim {
  calendarId: string;
  orgId: string;
  mailboxId: string;
  googleId: string | null;
  syncToken: string | null;
  pageToken: string | null;
  fullSyncStartedAt: Date | null;
  waiting: GoogleWaiting[];
}

/** A cancelled instance of a series that is not on the calendar yet. */
export type GoogleWaiting = Extract<GoogleCalendarChange, { kind: "cancelled" }> & {
  instanceOf: { googleId: string; recurrenceId: Date };
};

const waitingOf = (rows: { googleId: string; seriesGoogleId: string; recurrenceId: string }[]) =>
  rows.map(
    (row) =>
      ({
        kind: "cancelled",
        googleId: row.googleId,
        instanceOf: { googleId: row.seriesGoogleId, recurrenceId: new Date(row.recurrenceId) },
      }) satisfies GoogleWaiting,
  );

const CLAIM_MS = 5 * 60_000;

/**
 * Claims the Gmail inboxes' calendars whose Google sync is due, making the calendars that do not
 * exist yet. A claim pushes `next_sync_at` past the pass, so two passes at once never sync one
 * calendar; the pass sets the real next time when it saves.
 */
export async function claimGoogleCalendars(
  db: Db,
  mailboxes: readonly { id: string; orgId: string }[],
  options: { now?: Date; limit?: number } = {},
) {
  if (mailboxes.length === 0) return [];
  const now = options.now ?? new Date();
  await makeOwnCalendars(db, mailboxes);
  const due = await db
    .select({
      calendarId: calendarCalendars.id,
      orgId: calendarCalendars.orgId,
      mailboxId: calendarCalendars.mailboxId,
      googleId: calendarCalendars.googleId,
    })
    .from(calendarCalendars)
    .leftJoin(calendarGoogleSync, eq(calendarGoogleSync.calendarId, calendarCalendars.id))
    .where(
      and(
        inArray(
          calendarCalendars.mailboxId,
          mailboxes.map((m) => m.id),
        ),
        or(isNull(calendarGoogleSync.calendarId), lte(calendarGoogleSync.nextSyncAt, now)),
      ),
    )
    .orderBy(sql`${calendarGoogleSync.nextSyncAt} asc nulls first`, asc(calendarCalendars.id))
    .limit(options.limit ?? 20);
  if (due.length === 0) return [];
  const leaseUntil = new Date(now.getTime() + CLAIM_MS);
  const claimed = await db
    .insert(calendarGoogleSync)
    .values(due.map((d) => ({ calendarId: d.calendarId, orgId: d.orgId, nextSyncAt: leaseUntil })))
    .onConflictDoUpdate({
      target: calendarGoogleSync.calendarId,
      set: { nextSyncAt: leaseUntil },
      setWhere: lte(calendarGoogleSync.nextSyncAt, now),
    })
    .returning();
  const dueOf = new Map(due.map((d) => [d.calendarId, d]));
  return claimed.flatMap((row) => {
    const calendar = dueOf.get(row.calendarId);
    if (!calendar) return [];
    const claim: GoogleSyncClaim = {
      calendarId: row.calendarId,
      orgId: row.orgId,
      mailboxId: calendar.mailboxId,
      googleId: calendar.googleId,
      syncToken: row.syncToken,
      pageToken: row.pageToken,
      fullSyncStartedAt: row.fullSyncStartedAt,
      waiting: waitingOf(row.waiting),
    };
    return [claim];
  });
}

/** Where a pass left a calendar, and when it is next due. */
export async function saveGoogleSync(
  db: Db,
  calendarId: string,
  state: {
    syncToken: string | null;
    pageToken: string | null;
    fullSyncStartedAt: Date | null;
    waiting?: readonly GoogleWaiting[];
    state: "ok" | "no_access";
    nextSyncAt: Date;
    synced?: boolean;
  },
) {
  await db
    .update(calendarGoogleSync)
    .set({
      syncToken: state.syncToken,
      pageToken: state.pageToken,
      fullSyncStartedAt: state.fullSyncStartedAt,
      waiting: (state.waiting ?? []).map((w) => ({
        googleId: w.googleId,
        seriesGoogleId: w.instanceOf.googleId,
        recurrenceId: w.instanceOf.recurrenceId.toISOString(),
      })),
      state: state.state,
      nextSyncAt: state.nextSyncAt,
      ...(state.synced ? { syncedAt: new Date() } : {}),
    })
    .where(eq(calendarGoogleSync.calendarId, calendarId));
}

type Calendar = { id: string; orgId: string };

/**
 * Applies one page of Google's changes to an inbox's calendar, in one transaction, and says how
 * many changed it and which cancelled instances wait for a series it does not hold yet. An event made in Omni is Omni's and Google never changes it. For the rest,
 * Google and mail's invitations write the same rows by `UID`, and the higher
 * `(SEQUENCE, updated or DTSTAMP)` wins, so either order ends the same.
 */
export async function applyGoogleChanges(
  db: Db,
  calendar: Calendar,
  changes: readonly GoogleCalendarChange[],
  now = new Date(),
) {
  const none = { changed: 0, waiting: [] as GoogleWaiting[] };
  if (changes.length === 0) return none;
  return db.transaction(async (tx) => {
    const result = none;
    const ordered = changes.toSorted((a, b) => rank(a) - rank(b));
    for (const change of ordered) {
      const applied =
        change.kind === "event"
          ? await applyEvent(tx, calendar, change.googleId, change.event, now)
          : await applyCancel(tx, calendar, change, now);
      if (applied === "waiting" && change.kind === "cancelled" && change.instanceOf) {
        result.waiting.push({ ...change, instanceOf: change.instanceOf });
      } else if (applied === true) result.changed++;
    }
    return result;
  });
}

const rank = (change: GoogleCalendarChange) =>
  change.kind === "cancelled" ? 2 : change.event.recurrenceId ? 1 : 0;

function valuesOf(event: CalendarEvent, googleId: string, now: Date) {
  return {
    googleId,
    sequence: event.sequence,
    dtstamp: event.dtstamp,
    status: event.status,
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
    organizerAddress: event.organizer?.address ?? null,
    organizerName: event.organizer?.name ?? null,
    updatedAt: now,
  };
}

async function applyEvent(
  tx: Ex,
  calendar: Calendar,
  googleId: string,
  event: CalendarEvent,
  now: Date,
) {
  const current = await stored(tx, calendar.id, event.uid, event.recurrenceId);
  const series = event.recurrenceId ? await stored(tx, calendar.id, event.uid, null) : null;
  if ((current ?? series)?.source === "omni") return false;
  if (current && (older(event, current) || sameVersion(event, current))) {
    await tx
      .update(calendarEvents)
      .set({ googleId, updatedAt: now })
      .where(eq(calendarEvents.id, current.id));
    return false;
  }
  const values = valuesOf(event, googleId, now);
  let eventId = current?.id;
  if (eventId) {
    await tx.update(calendarEvents).set(values).where(eq(calendarEvents.id, eventId));
  } else {
    const [made] = await tx
      .insert(calendarEvents)
      .values({
        ...values,
        orgId: calendar.orgId,
        calendarId: calendar.id,
        uid: event.uid,
        recurrenceId: event.recurrenceId,
        source: "google",
      })
      .returning({ id: calendarEvents.id });
    if (!made) throw new Error("calendar event insert returned nothing");
    eventId = made.id;
  }
  await syncAttendees(tx, { orgId: calendar.orgId, calendarId: calendar.id }, eventId, event);
  return true;
}

const sameVersion = (event: CalendarEvent, current: Stored) =>
  event.sequence === current.sequence &&
  event.dtstamp !== null &&
  current.dtstamp !== null &&
  event.dtstamp.getTime() === current.dtstamp.getTime();

const cancellationStamp = (now: Date) =>
  sql`greatest(coalesce(${calendarEvents.dtstamp}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)`;

const notOmni = ne(calendarEvents.source, "omni");

async function applyCancel(
  tx: Ex,
  calendar: Calendar,
  change: Extract<GoogleCalendarChange, { kind: "cancelled" }>,
  now: Date,
) {
  const cancelled = {
    status: "cancelled" as const,
    dtstamp: cancellationStamp(now),
    updatedAt: now,
  };
  const [known] = await tx
    .select({
      id: calendarEvents.id,
      uid: calendarEvents.uid,
      recurrenceId: calendarEvents.recurrenceId,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendar.id),
        eq(calendarEvents.googleId, change.googleId),
        notOmni,
      ),
    );
  if (known) {
    const rows = known.recurrenceId
      ? eq(calendarEvents.id, known.id)
      : and(eq(calendarEvents.calendarId, calendar.id), eq(calendarEvents.uid, known.uid), notOmni);
    const changed = await tx
      .update(calendarEvents)
      .set(cancelled)
      .where(and(rows, ne(calendarEvents.status, "cancelled")))
      .returning({ id: calendarEvents.id });
    if (changed.length === 0) {
      await tx
        .update(calendarEvents)
        .set({ dtstamp: cancellationStamp(now), updatedAt: now })
        .where(rows);
    }
    return changed.length > 0;
  }
  if (!change.instanceOf) return false;
  return cancelInstance(tx, calendar, change.googleId, change.instanceOf, now);
}

async function cancelInstance(
  tx: Ex,
  calendar: Calendar,
  googleId: string,
  instanceOf: { googleId: string; recurrenceId: Date },
  now: Date,
) {
  const [series] = await tx
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendar.id),
        eq(calendarEvents.googleId, instanceOf.googleId),
        isNull(calendarEvents.recurrenceId),
      ),
    );
  if (!series) return "waiting" as const;
  if (series.source === "omni") return false;
  const start = instanceOf.recurrenceId;
  const length = series.endsAt.getTime() - series.startsAt.getTime();
  const end = new Date(start.getTime() + length);
  const day = (instant: Date) => instant.toISOString().slice(0, 10);
  const [before] = await tx
    .select({ status: calendarEvents.status })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendar.id),
        eq(calendarEvents.uid, series.uid),
        eq(calendarEvents.recurrenceId, start),
      ),
    );
  const made = await tx
    .insert(calendarEvents)
    .values({
      orgId: calendar.orgId,
      calendarId: calendar.id,
      uid: series.uid,
      recurrenceId: start,
      sequence: series.sequence,
      dtstamp: now,
      source: "google",
      status: "cancelled",
      busy: series.busy,
      title: series.title,
      startsAt: start,
      endsAt: end,
      allDay: series.allDay,
      startDay: series.allDay ? day(start) : null,
      endDay: series.allDay ? day(end) : null,
      timeZone: series.timeZone,
      recursUntil: end,
      organizerAddress: series.organizerAddress,
      organizerName: series.organizerName,
      googleId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [calendarEvents.calendarId, calendarEvents.uid, calendarEvents.recurrenceId],
      set: { status: "cancelled", googleId, dtstamp: cancellationStamp(now), updatedAt: now },
      setWhere: notOmni,
    })
    .returning({ id: calendarEvents.id });
  return made.length > 0 && before?.status !== "cancelled";
}

/**
 * Ends a full pass that started at `startedAt`: an event only Google gave that the pass did not
 * see is gone from Google, so it leaves the calendar. An event mail also brought stays, whichever
 * came first: an invitation for its `UID` was applied (or found older) on this calendar.
 */
export async function finishGoogleFullSync(db: Db, calendarId: string, startedAt: Date) {
  const removed = await db
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.calendarId, calendarId),
        eq(calendarEvents.source, "google"),
        lt(calendarEvents.updatedAt, startedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(calendarParts)
            .where(
              and(
                eq(calendarParts.calendarId, calendarEvents.calendarId),
                eq(calendarParts.uid, calendarEvents.uid),
                inArray(calendarParts.outcome, ["applied", "stale"]),
              ),
            ),
        ),
      ),
    )
    .returning({ id: calendarEvents.id });
  return removed.length;
}
