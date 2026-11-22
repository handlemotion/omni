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

/** Queues one step of a meeting's pipeline. */
export function enqueueMeeting(env: Env, job: Omit<MeetingJob, "kind">, delaySeconds = 0) {
  return env.AI_QUEUE.send(
    { kind: "meeting", ...job } satisfies MeetingJob,
    delaySeconds > 0 ? { delaySeconds } : undefined,
  );
}

/**
 * Runs one meeting step and settles its message: the next step is a new message (so a long poll
 * never uses up the message's retries), a transient failure is retried with a growing delay, and
 * anything else, or the last retry, marks the meeting failed with what went wrong.
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
  try {
    const result = await runMeetingStep(meetingRun, job);
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
    if (retryable(error) && message.attempts <= maxRetries) {
      log.warn("meetings.step_failed", { error, attempts: message.attempts });
      message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
      return;
    }
    const reason = error instanceof Error ? error.message : "the step failed";
    log.error("meetings.failed", { error, attempts: message.attempts });
    const from = error instanceof StepError ? error.from : null;
    const failed = from ? await meetingsPipeline(run.db).fail(job.meetingId, reason, from) : false;
    if (failed) await announceMeeting(meetingRun, job.orgId, job.meetingId, "failed");
    message.ack();
  }
}
