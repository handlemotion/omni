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

const MODEL_TIMEOUT_MS = 20_000;
const BATCH_START_BUDGET_MS = 10 * 60 * 1000;

/** A job of another kind, from a module: settles its own message, and says what it spent on AI. */
export type ModuleJob = { kind: string; orgId: string };
export type ModuleConsumer = (
  run: { env: Env; db: Db; config: Config; queue: string },
  message: Message<ModuleJob>,
  maxRetries: number,
) => Promise<{ usage: { tokensIn: number; tokensOut: number } } | void>;

/**
 * One handler for both queues the Worker consumes: AI jobs, and their dead-letter queue (by
 * convention the source queue's name plus `-dlq`).
 */
export async function consumeQueue(
  batch: MessageBatch<AiJob | ModuleJob>,
  env: Env,
  consumers: Record<string, ModuleConsumer> = {},
) {
  if (batch.queue.endsWith("-dlq")) return consumeDeadLetters(batch as MessageBatch<AiJob>, env);
  return consumeAiQueue(batch, env, consumers);
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

function recordFromDeadLetterQueue(db: Db, queue: string, source: string, message: Message<AiJob>) {
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
  ) satisfies Effect.Effect<void>;
}

/**
 * `superseded`: a newer message arrived mid-job; that message's own job files the thread.
 * `changed`: mail was merged in or pruned while the model ran, so the done marker was not set; the job
 *   runs again on the thread as it is now.
 * `triage_paused`: the workspace used its monthly allowance; the thread records until when.
 * `billing_inactive`: no plan in good standing, so no AI at all.
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
export async function consumeAiQueue(
  batch: MessageBatch<AiJob | ModuleJob>,
  env: Env,
  consumers: Record<string, ModuleConsumer> = {},
) {
  const config = loadConfig(env);
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
      const started = Date.now();
      yield* Effect.forEach(
        batch.messages,
        (message) =>
          Date.now() - started >= BATCH_START_BUDGET_MS
            ? Effect.sync(() => message.retry({ delaySeconds: 5 }))
            : consumerOf(consumers, message)
              ? Effect.promise(() =>
                  consumeModuleMessage(run, consumers, message as Message<ModuleJob>),
                )
              : consumeAiMessage(run, message as Message<AiJob>),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.scoped),
  );
}

const consumerOf = (
  consumers: Record<string, ModuleConsumer>,
  message: Message<AiJob | ModuleJob>,
) =>
  message.body?.kind && message.body.kind !== "thread" ? consumers[message.body.kind] : undefined;

async function consumeModuleMessage(
  run: AiRun,
  consumers: Record<string, ModuleConsumer>,
  message: Message<ModuleJob>,
) {
  const consume = consumers[message.body.kind];
  if (!consume) return message.ack();
  const spent = await consume(run, message, AI_QUEUE_MAX_RETRIES);
  const usage = spent?.usage;
  if (usage && (usage.tokensIn || usage.tokensOut)) {
    await addAiUsage(run.db, message.body.orgId, new Date().toISOString().slice(0, 10), usage);
  }
}

function consumeAiMessage(run: AiRun, message: Message<AiJob>) {
  const log = jobLogger(run.queue, message.body);
  const started = Date.now();
  return processAiJob(run, message.body, log).pipe(
    Effect.catchDefect((cause) => Effect.fail(new Retryable({ step: "job", cause }))),
    Effect.matchEffect({
      onSuccess: (outcome) => Effect.sync(() => settle(message, outcome, log, started)),
      onFailure: (failure) => settleFailure(run, message, failure, log, started),
    }),
  ) satisfies Effect.Effect<void>;
}

function processAiJob(run: AiRun, job: AiJob, log: Logger) {
  const { env, db, config, models } = run;
  return Effect.gen(function* () {
    if (typeof job?.threadId !== "string" || typeof job.mailboxId !== "string") {
      return yield* new Permanent({ step: "validate", cause: new Error("malformed AI job") });
    }
    const outcome = yield* attempt("triage", () =>
      Sentry.withScope((scope) => {
        if (job.requestId) scope.setTag("request_id", job.requestId);
        return runAiJob(db, models, config, job, {
          outboxChanged: () => pingMailService({ config, requestId: jobRequestId(job), log }),
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
  }) satisfies Effect.Effect<AiJobOutcome, JobError>;
}

function settle(message: Message<AiJob>, outcome: AiJobOutcome, log: Logger, started: number) {
  const { threadId } = message.body;
  log.info("ai.job", { threadId, outcome, durationMs: Date.now() - started });
  if (outcome === "changed") message.retry({ delaySeconds: 5 });
  else if (outcome === "ingesting") message.retry({ delaySeconds: 30 });
  else message.ack();
}

const settleFailure: (
  run: AiRun,
  message: Message<AiJob>,
  failure: JobError,
  log: Logger,
  started: number,
) => Effect.Effect<void> = (run, message, failure, log, started) => {
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
  const retry = () =>
    message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
  if (!permanent && message.attempts <= AI_QUEUE_MAX_RETRIES) {
    return Effect.sync(() => {
      log.warn("ai.job_failed", fields);
      retry();
    });
  }
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
};

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
) {
  const thread = await loadThreadForAi(db, job.threadId);
  const latest = thread?.messages.at(-1);
  if (!thread || !latest) return "missing" satisfies AiJobOutcome;
  if (thread.summaryMessageId === latest.id) return "done_already" satisfies AiJobOutcome;

  const triageEnabled = Boolean(config.TYPESAFE_API_KEY || config.ANTHROPIC_API_KEY);
  const isUs = (address: string) => thread.selfAddresses.has(address.toLowerCase());
  const day = new Date().toISOString().slice(0, 10);

  let filed = thread.triage !== null || thread.triageMessageId !== null;
  let triaged = false;
  if (thread.triageMessageId !== latest.id) {
    const input = triageInputFor(thread.messages, isUs);
    const helpdesk = await helpdeskContextForAi(db, thread.mailboxId);
    if (helpdesk) {
      if (await awaitingIngest(db, latest.id)) return "ingesting" satisfies AiJobOutcome;
      input.helpdesk = helpdesk;
    }
    const byRule = triageByRule(input);
    if (triageEnabled && !byRule) {
      const gate = await gateTriage(db, config, { orgId: thread.orgId, messageId: latest.id });
      if (!gate.run) {
        if (gate.reason === "allowance_reached") {
          await markTriagePaused(db, thread.id, gate.until);
          return "triage_paused" satisfies AiJobOutcome;
        }
        return "billing_inactive" satisfies AiJobOutcome;
      }
    }
    const result = byRule ?? (triageEnabled ? await triage(models.triage, input) : null);
    if (result) {
      await addAiUsage(db, thread.orgId, day, result.usage);
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
      const saved = await saveTriage(db, thread.id, {
        bucket: result.bucket,
        confidence: result.confidence,
        messageId: latest.id,
      });
      if (!saved) return "superseded" satisfies AiJobOutcome;
      filed = true;
      triaged = true;
    }
  }
  if (!filed) return "no_model" satisfies AiJobOutcome;

  const saved = await saveSummary(db, thread.id, {
    summary: null,
    messageId: latest.id,
    messageCount: thread.messages.length,
  });
  if (!saved) return "changed" satisfies AiJobOutcome;
  return (triaged ? "triaged" : "done_already") satisfies AiJobOutcome;
}
