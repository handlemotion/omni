import { meetingsPipeline, type Db } from "@omni/db";
import type { Config } from "../env.ts";
import { createLogger } from "../log.ts";
import {
  announceMeeting,
  MEETING_STEPS,
  retryable,
  runMeetingStep,
  StepError,
  type MeetingJob,
  type MeetingRun,
} from "./jobs.ts";

export type { MeetingJob } from "./jobs.ts";

/** How many times one step of a meeting is tried before the meeting is marked failed. */
export const MAX_STEP_ATTEMPTS = 5;
/** No retry waits longer than this. The sweep's `STALLED_MS` is longer still. */
export const MAX_RETRY_SECONDS = 600;

/**
 * The wait before try `attempt + 1`: `first` seconds (`MEETINGS_FIRST_RETRY_SECONDS`), doubled
 * each time and capped, with up to a fifth added at random so meetings that failed together (an
 * engine outage) do not all come back at the same second.
 */
export function retryDelay(attempt: number, first: number, random = Math.random()) {
  const base = Math.min(first * 2 ** Math.max(0, attempt - 1), MAX_RETRY_SECONDS);
  return Math.min(MAX_RETRY_SECONDS, Math.round(base * (1 + random / 5)));
}

/** Queues one step of a meeting's pipeline. */
export function enqueueMeeting(env: Env, job: Omit<MeetingJob, "kind">, delaySeconds = 0) {
  return env.AI_QUEUE.send(
    { kind: "meeting", ...job } satisfies MeetingJob,
    delaySeconds > 0 ? { delaySeconds } : undefined,
  );
}

/**
 * Runs one meeting step and settles its message: the next step is a new message (so a long poll
 * never uses up the message's retries), a transient failure is retried with a capped, growing
 * delay, and anything else, or the last try, marks the meeting failed with what went wrong.
 * Tries are counted on the meeting (`failedAttempt`), so a copy of the step the sweep sent, or
 * a redelivery after the Worker restarted, never starts the count again.
 */
export async function consumeMeetingMessage(
  run: { env: Env; db: Db; config: Config; queue: string },
  message: Message<{ kind: string; orgId: string }>,
  maxRetries: number,
) {
  const job = message.body as MeetingJob;
  if (typeof job.meetingId !== "string" || !MEETING_STEPS.includes(job.step)) {
    message.ack();
    return;
  }
  const log = createLogger({
    component: "queue",
    queue: run.queue,
    requestId: job.requestId,
    orgId: job.orgId,
    meetingId: job.meetingId,
    step: job.step,
  });
  const meetingRun: MeetingRun = { env: run.env, db: run.db, config: run.config, log };
  const started = Date.now();
  const pipeline = meetingsPipeline(run.db);
  try {
    const result = await runMeetingStep(meetingRun, job);
    await pipeline.succeeded(job.meetingId);
    if (result.next) {
      await enqueueMeeting(
        run.env,
        {
          meetingId: job.meetingId,
          orgId: job.orgId,
          step: result.next.step,
          requestId: job.requestId,
        },
        result.next.delaySeconds,
      );
    }
    if (result.changed) await announceMeeting(meetingRun, job.orgId, job.meetingId, result.changed);
    log.info("meetings.step", {
      next: result.next?.step ?? null,
      durationMs: Date.now() - started,
    });
    message.ack();
    return { usage: result.usage };
  } catch (error) {
    const attempts = await pipeline.failedAttempt(job.meetingId).catch(() => message.attempts);
    if (retryable(error) && attempts < MAX_STEP_ATTEMPTS && message.attempts <= maxRetries) {
      log.warn("meetings.step_failed", { error, attempts });
      message.retry({
        delaySeconds: retryDelay(attempts, run.config.MEETINGS_FIRST_RETRY_SECONDS),
      });
      return;
    }
    const reason = error instanceof Error ? error.message : "the step failed";
    log.error("meetings.failed", { error, attempts });
    const from = error instanceof StepError ? error.from : null;
    const failed = from ? await pipeline.fail(job.meetingId, reason, from) : false;
    if (failed) await announceMeeting(meetingRun, job.orgId, job.meetingId, "failed");
    message.ack();
  }
}
