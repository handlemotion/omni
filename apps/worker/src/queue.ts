// AI queue consumer: triage for a thread after new mail, in either direction. A job
// names only the thread; the consumer reads its current state and triages the latest message, so
// a redelivered or duplicate job converges on the same result, and work already done for that
// message (`triage_message_id`, and `summary_message_id` as the job's done marker) is skipped without a model call.
// The consumer is an Effect program at the edge (ADR 0038 decision 2, `job-effects.ts`): typed
// failures decide ack, retry or dead letter; `runAiJob` stays a plain async function.
import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/cloudflare";
import {
  chooseTriageClient,
  DEFAULT_AUTO_FILE_THRESHOLD,
  triage,
  triageByRule,
  triageInputFor,
  type TriageClient,
} from "@omni/ai";
import {
  addAiUsage,
  applyAiHelpdeskTriage,
  awaitingIngest,
  helpdeskContextForAi,
  loadThreadForAi,
  markTriagePaused,
  recordDeadLetter,
  saveSummary,
  saveTriage,
  type Db,
} from "@omni/db";
import { Effect } from "effect";
import { gateTriage } from "./billing.ts";
import { loadConfig, type Config } from "./env.ts";
import {
  attempt,
  type JobError,
  Permanent,
  Retryable,
  retryTransient,
  scopedDb,
} from "./job-effects.ts";
import { createLogger, type Logger } from "./log.ts";
import { pingMailService } from "./mail-service.ts";
import { fanOut, notifyMembers } from "./realtime.ts";

/**
 * Ids only, never mail content. `orgId`, `jobId` and `requestId` (the request that queued it)
 * are absent from jobs queued before they existed.
 */
export type AiJob = {
  kind: "thread";
  threadId: string;
  mailboxId: string;
  orgId?: string;
  jobId?: string;
  requestId?: string;
};

/** Must match `max_retries` of the `omni-ai` consumer in wrangler.jsonc. */
export const AI_QUEUE_MAX_RETRIES = 5;

/** One model request's cancelling timeout (TypeSafe's client uses the same 20 s). */
const MODEL_TIMEOUT_MS = 20_000;
/**
 * No message starts after this much of a batch's run. A job is at most two model calls, each tried
 * three times at 20 s, about two minutes, so the last one started still ends inside a consumer's
 * 15-minute wall clock.
 */
const BATCH_START_BUDGET_MS = 10 * 60 * 1000;

/**
 * One handler for both queues the Worker consumes: AI jobs, and their dead-letter queue (by
 * convention the source queue's name plus `-dlq`).
 */
export async function consumeQueue(batch: MessageBatch<AiJob>, env: Env) {
  if (batch.queue.endsWith("-dlq")) return consumeDeadLetters(batch, env);
  return consumeAiQueue(batch, env);
}

/**
 * A job that used up its retries lands here. Recorded in `dead_letters` (listed with failed
 * outbox actions by `pnpm --filter @omni/mail dead-letters`) and acked. The consumer's last attempt
 * usually recorded it already, with its error; this catches jobs whose consumer died mid-run.
 */
export async function consumeDeadLetters(batch: MessageBatch<AiJob>, env: Env) {
  const source = batch.queue.slice(0, -"-dlq".length);
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      yield* Effect.forEach(
        batch.messages,
        (message) => recordFromDeadLetterQueue(db, batch.queue, source, message),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.scoped),
  );
}

function recordFromDeadLetterQueue(
  db: Db,
  queue: string,
  source: string,
  message: Message<AiJob>,
): Effect.Effect<void> {
  const job = message.body;
  const log = jobLogger(queue, job);
  const record = attempt("record_dead_letter", () =>
    recordDeadLetter(db, {
      ...deadLetterOf(source, message),
      error: null,
    }),
  );
  return record.pipe(
    retryTransient,
    Effect.match({
      onSuccess: (recorded) => {
        log.error("queue.dead_letter", {
          jobId: job.jobId ?? message.id,
          threadId: job.threadId,
          recorded,
        });
        message.ack();
      },
      onFailure: (failure) => {
        log.error("queue.dead_letter_not_recorded", {
          error: failure.cause,
          threadId: job.threadId,
        });
        message.retry({ delaySeconds: 60 });
      },
    }),
  );
}

/**
 * `superseded`: a newer message arrived mid-job; that message's own job files the thread.
 * `changed`: mail was merged in or pruned while the model ran, so the done marker was not set; the job
 *   runs again on the thread as it is now.
 * `triage_paused`: the workspace used its monthly allowance; the thread records until when.
 * `billing_inactive`: no plan in good standing, so no AI at all (ADR 0015).
 * `ingesting`: a shared inbox's message whose own ingest has not run yet; the job runs again shortly.
 */
export type AiJobOutcome =
  | "missing"
  | "triage_paused"
  | "billing_inactive"
  | "done_already"
  | "no_model"
  | "superseded"
  | "changed"
  | "ingesting"
  | "triaged";

interface AiRun {
  env: Env;
  db: Db;
  config: Config;
  models: { triage: TriageClient };
  queue: string;
}

/**
 * Each message is settled on its own: acked, retried later, or dead-lettered. A retryable failure
 * (a Hyperdrive blip, a model overload, a timeout) is retried by Queues with a growing delay and
 * dead-lettered after `AI_QUEUE_MAX_RETRIES`; a permanent one (a malformed job, a request the
 * provider refuses) is recorded as a dead letter at once, since no retry can fix it.
 */
export async function consumeAiQueue(batch: MessageBatch<AiJob>, env: Env) {
  const config = loadConfig(env);
  // With no key the client is never called: only the wordless-reply rule runs (see runAiJob).
  // A cancelling timeout per request and no SDK retries: the job's own retries (`retryTransient`,
  // then Queues) are the only ones, so a stalled request ends well inside the batch's budget.
  const anthropic = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY ?? null,
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 0,
  });
  const models = {
    triage: chooseTriageClient({
      provider: config.TRIAGE_PROVIDER,
      typesafeApiKey: config.TYPESAFE_API_KEY,
      jevModel: config.JEV_MODEL,
      typesafeApiUrl: config.TYPESAFE_API_URL,
      anthropic,
    }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const run: AiRun = { env, db, config, models, queue: batch.queue };
      // One at a time, as before: a settled message never stops the rest of the batch. Past the
      // batch's start budget the rest go back to Queues untouched, so slow jobs early in a batch
      // never run the invocation out of time for the ones after them.
      const started = Date.now();
      yield* Effect.forEach(
        batch.messages,
        (message) =>
          Date.now() - started < BATCH_START_BUDGET_MS
            ? consumeAiMessage(run, message)
            : Effect.sync(() => message.retry({ delaySeconds: 5 })),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.scoped),
  );
}

function consumeAiMessage(run: AiRun, message: Message<AiJob>): Effect.Effect<void> {
  const log = jobLogger(run.queue, message.body);
  const started = Date.now();
  return processAiJob(run, message.body, log).pipe(
    // A bug in the job is a failure like any other: retried, then dead-lettered.
    Effect.catchDefect((cause) => Effect.fail(new Retryable({ step: "job", cause }))),
    Effect.matchEffect({
      onSuccess: (outcome) => Effect.sync(() => settle(message, outcome, log, started)),
      onFailure: (failure) => settleFailure(run, message, failure, log, started),
    }),
  );
}

/**
 * The job, then the live update for the people who see the thread. No `Effect.timeout` here: it
 * would abandon the promise, not stop it, and a retry would then run beside writes still in
 * flight. The model calls carry their own cancelling timeouts (`MODEL_TIMEOUT_MS`, TypeSafe's
 * 20 s), so an attempt always ends before the next one starts.
 */
function processAiJob(run: AiRun, job: AiJob, log: Logger): Effect.Effect<AiJobOutcome, JobError> {
  const { env, db, config, models } = run;
  return Effect.gen(function* () {
    if (typeof job?.threadId !== "string" || typeof job.mailboxId !== "string") {
      return yield* new Permanent({ step: "validate", cause: new Error("malformed AI job") });
    }
    const outcome = yield* attempt("triage", () =>
      Sentry.withScope((scope) => {
        if (job.requestId) scope.setTag("request_id", job.requestId);
        return runAiJob(db, models, config, job, {
          // A noise resolve queued its IMAP archive: tell the mail service.
          outboxChanged: () => pingMailService({ config, requestId: jobRequestId(job), log }),
          // AI handed it to someone: their notification list updates live.
          assigned: (orgId, memberIds) =>
            notifyMembers(env, db, { orgId, threadId: job.threadId, memberIds, kind: "assigned" }),
        });
      }),
    ).pipe(retryTransient);
    if (outcome === "triaged" || outcome === "triage_paused") {
      const changes = new Map([[job.mailboxId, new Set([job.threadId])]]);
      yield* attempt("fan_out", () => fanOut(env, db, config, changes)).pipe(retryTransient);
    }
    return outcome;
  });
}

function settle(message: Message<AiJob>, outcome: AiJobOutcome, log: Logger, started: number) {
  const { threadId } = message.body;
  log.info("ai.job", { threadId, outcome, durationMs: Date.now() - started });
  // Nothing else is sure to queue a job for a prune, so this one reads the thread again.
  if (outcome === "changed") message.retry({ delaySeconds: 5 });
  // The ingest usually lands within seconds; at 30s apart, the retries outlast
  // `INGEST_WAIT_MS`, after which the job triages the message as it is.
  else if (outcome === "ingesting") message.retry({ delaySeconds: 30 });
  else message.ack();
}

function settleFailure(
  run: AiRun,
  message: Message<AiJob>,
  failure: JobError,
  log: Logger,
  started: number,
): Effect.Effect<void> {
  const permanent = failure instanceof Permanent;
  const fields = {
    threadId: message.body?.threadId,
    jobId: message.body?.jobId ?? message.id,
    attempts: message.attempts,
    error: failure.cause,
    step: failure.step,
    permanent,
    durationMs: Date.now() - started,
  };
  // Backoff grows with each attempt; after max_retries the job lands in the DLQ.
  const retry = () =>
    message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
  if (!permanent && message.attempts <= AI_QUEUE_MAX_RETRIES) {
    return Effect.sync(() => {
      log.warn("ai.job_failed", fields);
      retry();
    });
  }
  // Permanent, or the last attempt: record the dead letter with its error now. The last attempt
  // is still retried, which hands it to the DLQ as configured; that copy finds it recorded. A
  // permanent failure is acked once recorded; if it could not be recorded, it is retried.
  log.error("ai.job_dead", fields);
  const error = failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
  return attempt("record_dead_letter", () =>
    recordDeadLetter(run.db, { ...deadLetterOf(run.queue, message), error }),
  ).pipe(
    retryTransient,
    Effect.match({
      onSuccess: () => (permanent ? message.ack() : retry()),
      onFailure: (recordFailure) => {
        log.error("ai.dead_letter_not_recorded", { error: recordFailure.cause });
        retry();
      },
    }),
  );
}

/** A dead letter's row for this message, from `queue`; the caller adds the error. */
function deadLetterOf(queue: string, message: Message<AiJob>) {
  const job = message.body;
  return {
    orgId: job?.orgId ?? null,
    threadId: job?.threadId,
    queue,
    jobId: job?.jobId ?? message.id,
    job: { ...job },
    attempts: message.attempts,
    requestId: job?.requestId ?? null,
  };
}

function jobLogger(queue: string, job: AiJob | undefined) {
  return createLogger({
    component: "queue",
    queue,
    requestId: job?.requestId,
    orgId: job?.orgId,
  });
}

function jobRequestId(job: AiJob) {
  return job.requestId ?? job.jobId ?? crypto.randomUUID();
}

export async function runAiJob(
  db: Db,
  models: { triage: TriageClient },
  config: Config,
  job: AiJob,
  hooks: {
    outboxChanged?: () => Promise<unknown>;
    assigned?: (orgId: string, memberIds: string[]) => Promise<unknown>;
  } = {},
): Promise<AiJobOutcome> {
  const thread = await loadThreadForAi(db, job.threadId);
  const latest = thread?.messages.at(-1);
  if (!thread || !latest) return "missing";
  // The done marker (`summary_message_id`, named for the removed summaries) moves only after the
  // whole job ran for this message.
  if (thread.summaryMessageId === latest.id) return "done_already";

  // Triage runs on Jev or Claude.
  const triageEnabled = Boolean(config.TYPESAFE_API_KEY || config.ANTHROPIC_API_KEY);
  const isUs = (address: string) => thread.selfAddresses.has(address.toLowerCase());
  const day = new Date().toISOString().slice(0, 10);

  let bucket = thread.triage;
  let triaged = false;
  // The triage describes the latest message. Already done for it (a redelivery, or a retry after
  // the marker failed): reuse it. A newer message, from either side, re-triages, even a thread a
  // person re-sorted. Without a model only the wordless-reply rule can file a thread.
  if (thread.triageMessageId !== latest.id) {
    const input = triageInputFor(thread.messages, isUs);
    // A shared inbox: triage also judges priority, tags (ADR 0022) and who takes it (ADR 0033).
    const helpdesk = await helpdeskContextForAi(db, thread.mailboxId);
    if (helpdesk) {
      // Its status rule runs first, so what triage sets is not undone by it (nor round-robin beaten).
      if (await awaitingIngest(db, latest.id)) return "ingesting";
      input.helpdesk = helpdesk;
    }
    const byRule = triageByRule(input);
    // A model call counts against the workspace's monthly allowance (ADR 0015); the rule is free.
    if (triageEnabled && !byRule) {
      const gate = await gateTriage(db, config, { orgId: thread.orgId, messageId: latest.id });
      if (!gate.run) {
        if (gate.reason === "allowance_reached") {
          await markTriagePaused(db, thread.id, gate.until);
          return "triage_paused";
        }
        return "billing_inactive";
      }
    }
    const result = byRule ?? (triageEnabled ? await triage(models.triage, input) : null);
    if (result) {
      await addAiUsage(db, thread.orgId, day, result.usage);
      // Before the triage is saved: a crash in between re-triages, and this applies again as a
      // no-op, instead of being skipped as done.
      if (result.helpdesk) {
        const applied = await applyAiHelpdeskTriage(db, {
          threadId: thread.id,
          messageId: latest.id,
          changes: {
            ...result.helpdesk,
            resolveNoise:
              result.bucket === "noise" && result.confidence >= DEFAULT_AUTO_FILE_THRESHOLD,
          },
        });
        if (applied.applied && applied.queuedActions > 0) await hooks.outboxChanged?.();
        if (applied.applied && applied.notified.length > 0) {
          await hooks.assigned?.(thread.orgId, applied.notified);
        }
      }
      // Lanes are derived on read: below the auto-file confidence a thread shows in Unsure.
      const saved = await saveTriage(db, thread.id, {
        bucket: result.bucket,
        confidence: result.confidence,
        messageId: latest.id,
      });
      if (!saved) return "superseded";
      bucket = result.bucket;
      triaged = true;
    }
  }
  if (!bucket) return "no_model";

  // The job is complete for this message: the marker makes a redelivery a no-op. Summaries were
  // removed (ADR 0028), so the marker is all that is written.
  const saved = await saveSummary(db, thread.id, {
    summary: null,
    messageId: latest.id,
    messageCount: thread.messages.length,
  });
  if (!saved) return "changed";
  return triaged ? "triaged" : "done_already";
}
