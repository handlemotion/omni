import { meetingsPipeline } from "@omni/db";
import { Effect } from "effect";
import { attempt, runJob, scopedDb } from "../job-effects.ts";
import { createLogger } from "../log.ts";
import { enqueueMeeting } from "./queue.ts";

/**
 * A meeting untouched this long mid-pipeline lost its next step and is sent again. Longer than
 * the longest retry delay (`MAX_RETRY_SECONDS`), so a step waiting on its retry is never sent twice.
 */
export const STALLED_MS = 15 * 60_000;

/** The meetings' every-minute work: send stalled meetings on, so no lost hand-off strands one. */
export function meetingsMinute(env: Env) {
  const log = createLogger({ component: "meetings.sweep" });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const pipeline = meetingsPipeline(db);
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
      return stalled.length;
    }),
  );
}
