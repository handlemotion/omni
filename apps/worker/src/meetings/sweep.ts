import { meetingsPipeline, type Db } from "@omni/db";
import { Effect } from "effect";
import { gateMeter } from "../billing.ts";
import { loadConfig } from "../env.ts";
import { attempt, runJob, scopedDb } from "../job-effects.ts";
import { createLogger } from "../log.ts";
import { enqueueMeeting } from "./queue.ts";

/**
 * A meeting untouched this long mid-pipeline lost its next step and is sent again. Longer than
 * the longest retry delay (`MAX_RETRY_SECONDS`), so a step waiting on its retry is never sent twice.
 */
export const STALLED_MS = 15 * 60_000;

/**
 * A recording nobody has heard from for this long was never stopped (the tab closed for good):
 * it is stopped with the chunks that arrived, so what was said is still transcribed. Long enough
 * that a laptop that slept through a night, or was offline for a flight, comes back first.
 */
export const ABANDONED_MS = 12 * 3_600_000;

async function stopAbandoned(env: Env, db: Db, meeting: { id: string; orgId: string }) {
  const stopped = await meetingsPipeline(db).stopAbandoned(meeting.id, ABANDONED_MS);
  if (!stopped) return;
  const { durationMs } = stopped;
  await gateMeter(db, loadConfig(env), {
    orgId: meeting.orgId,
    meter: "meetingMinutes",
    key: `meeting:${meeting.id}`,
    amount: Math.max(1, Math.ceil(durationMs / 60_000)),
    always: true,
  });
  await enqueueMeeting(env, { meetingId: meeting.id, orgId: meeting.orgId, step: "transcribe" });
}

/**
 * The meetings' every-minute work: send stalled meetings on, so no lost hand-off strands one,
 * and stop recordings whose recorder never came back.
 */
export function meetingsMinute(env: Env) {
  const log = createLogger({ component: "meetings.sweep" });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const pipeline = meetingsPipeline(db);
      const abandoned = yield* attempt("meetings_abandoned", () =>
        pipeline.abandoned(ABANDONED_MS),
      );
      for (const meeting of abandoned) {
        yield* attempt("meetings_stop_abandoned", () => stopAbandoned(env, db, meeting));
      }
      if (abandoned.length > 0) log.info("meetings.abandoned", { count: abandoned.length });
      const stalled = yield* attempt("meetings_stalled", () => pipeline.stalled(STALLED_MS));
      for (const meeting of stalled) {
        yield* attempt("meetings_resend", async () => {
          await enqueueMeeting(env, {
            meetingId: meeting.id,
            orgId: meeting.orgId,
            step: "transcribe",
          });
          await pipeline.nudged(meeting.id);
        });
      }
      if (stalled.length > 0) log.info("meetings.resent", { count: stalled.length });
      return stalled.length + abandoned.length;
    }),
  );
}
