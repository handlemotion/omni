import { CALENDAR_PART_MAX_BYTES, parseCalendar } from "@omni/mail-core/calendar";
import {
  advanceCalendarSweep,
  applyCalendarPart,
  calendarArrivals,
  calendarSweepPage,
  type CalendarAttachment,
  type Db,
} from "@omni/db";
import { Effect } from "effect";
import { retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";

const SWEEP_MAX_PAGES = 10;
const SWEEP_BUDGET_MS = 20_000;

/**
 * Reads one calendar attachment's bytes from the mail bucket and applies it. A part whose object
 * is gone is recorded as such; one over the size cap is never read whole.
 */
export async function ingestPart(bucket: R2Bucket, db: Db, part: CalendarAttachment) {
  if (part.size > CALENDAR_PART_MAX_BYTES) {
    return applyCalendarPart(db, part, { ok: false, reason: "too_large" });
  }
  const object = await bucket.get(part.r2Key);
  if (!object) return applyCalendarPart(db, part, { ok: false, reason: "missing" });
  if (object.size > CALENDAR_PART_MAX_BYTES) {
    await object.body.cancel();
    return applyCalendarPart(db, part, { ok: false, reason: "too_large" });
  }
  return applyCalendarPart(db, part, parseCalendar(await object.text()));
}

type Tally = Record<string, number>;

async function ingestAll(env: Env, db: Db, parts: CalendarAttachment[], tally: Tally) {
  for (const part of parts) {
    const result = await ingestPart(env.MAIL_BUCKET, db, part);
    tally[result.status] = (tally[result.status] ?? 0) + 1;
  }
}

/**
 * The sweep (`docs/spec/calendar.md`, "Ingesting invitations"): pages through mail's calendar
 * attachments from where it stopped until a page is empty, `SWEEP_MAX_PAGES` ran or the budget is
 * spent. A page that fails is read again next time; parts it applied are not applied twice.
 */
export function sweepInvitations(env: Env, db: Db, log: Logger) {
  return Effect.gen(function* () {
    const deadline = Date.now() + SWEEP_BUDGET_MS;
    const tally: Tally = {};
    for (let page = 0; page < SWEEP_MAX_PAGES && Date.now() < deadline; page++) {
      const { parts, last } = yield* retried("calendar_page", () => calendarSweepPage(db));
      yield* retried("calendar_apply", () => ingestAll(env, db, parts, tally));
      if (!last) break;
      yield* retried("calendar_advance", () => advanceCalendarSweep(db, last));
    }
    if (Object.keys(tally).length > 0) log.info("calendar.swept", tally);
    return tally;
  });
}

/** The calendar's every-minute work: the sweep. */
export function calendarMinute(env: Env) {
  const log = createLogger({ component: "calendar", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      yield* sweepInvitations(env, db, log);
    }),
  );
}

/**
 * The fast path: the parts the messages that just arrived brought, applied at once rather than at
 * the next sweep. Best effort; the sweep reaches whatever this misses.
 */
export async function calendarArrived(
  env: Env,
  db: Db,
  messageIds: readonly string[],
  log: Logger,
) {
  const tally: Tally = {};
  await ingestAll(env, db, await calendarArrivals(db, messageIds), tally);
  if (Object.keys(tally).length > 0) log.info("calendar.arrived", tally);
  return tally;
}
