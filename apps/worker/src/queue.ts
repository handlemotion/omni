// AI queue consumer: triage and summary for a thread after new mail, in either direction. A job
// names only the thread; the consumer reads its current state and triages the latest message, so
// a redelivered or duplicate job converges on the same result, and work already done for that
// message (`triage_message_id`, `summary_message_id`) is skipped without a model call.
import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/cloudflare";
import {
  chooseTriageClient,
  shouldSummarize,
  summarize,
  triage,
  triageByRule,
  triageInputFor,
  type ModelClient,
  type TriageClient,
} from "@omni/ai";
import {
  addAiUsage,
  createDb,
  getAiUsage,
  loadThreadForAi,
  recordDeadLetter,
  saveSummary,
  saveTriage,
  type Db,
} from "@omni/db";
import { loadConfig, type Config } from "./env.ts";
import { createLogger } from "./log.ts";
import { fanOut } from "./realtime.ts";

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
  const { db, close } = createDb(env.HYPERDRIVE.connectionString, {
    max: 2,
    fetch_types: false,
    onnotice: () => {},
  });
  const source = batch.queue.slice(0, -"-dlq".length);
  try {
    for (const message of batch.messages) {
      const job = message.body;
      const log = createLogger({
        component: "queue",
        queue: batch.queue,
        requestId: job.requestId,
        orgId: job.orgId,
      });
      try {
        const recorded = await recordDeadLetter(db, {
          orgId: job.orgId ?? null,
          threadId: job.threadId,
          queue: source,
          jobId: job.jobId ?? message.id,
          job: { ...job },
          error: null,
          attempts: message.attempts,
          requestId: job.requestId ?? null,
        });
        log.error("queue.dead_letter", {
          jobId: job.jobId ?? message.id,
          threadId: job.threadId,
          recorded,
        });
        message.ack();
      } catch (error) {
        log.error("queue.dead_letter_not_recorded", { error, threadId: job.threadId });
        message.retry({ delaySeconds: 60 });
      }
    }
  } finally {
    await close();
  }
}

/** `superseded`: a newer message arrived mid-job; that message's own job files the thread. */
export type AiJobOutcome =
  | "missing"
  | "done_already"
  | "no_model"
  | "superseded"
  | "triaged"
  | "summarized";

export async function consumeAiQueue(batch: MessageBatch<AiJob>, env: Env) {
  const config = loadConfig(env);
  // With no key the client is never called: only the wordless-reply rule runs (see runAiJob).
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? null });
  const models = {
    triage: chooseTriageClient({
      provider: config.TRIAGE_PROVIDER,
      typesafeApiKey: config.TYPESAFE_API_KEY,
      jevModel: config.JEV_MODEL,
      typesafeApiUrl: config.TYPESAFE_API_URL,
      anthropic,
    }),
    summary: anthropic,
  };
  const { db, close } = createDb(env.HYPERDRIVE.connectionString, {
    max: 2,
    fetch_types: false,
    onnotice: () => {},
  });
  try {
    for (const message of batch.messages) {
      const job = message.body;
      const log = createLogger({
        component: "queue",
        queue: batch.queue,
        requestId: job.requestId,
        orgId: job.orgId,
      });
      const started = Date.now();
      try {
        const outcome = await Sentry.withScope(async (scope) => {
          if (job.requestId) scope.setTag("request_id", job.requestId);
          return runAiJob(db, models, config, job);
        });
        if (outcome === "triaged" || outcome === "summarized") {
          const { mailboxId, threadId } = job;
          await fanOut(env, db, config, new Map([[mailboxId, new Set([threadId])]]));
        }
        log.info("ai.job", { threadId: job.threadId, outcome, durationMs: Date.now() - started });
        message.ack();
      } catch (error) {
        const fields = {
          threadId: job.threadId,
          jobId: job.jobId ?? message.id,
          attempts: message.attempts,
          error,
          durationMs: Date.now() - started,
        };
        // The last attempt: record the dead letter with its error now; the DLQ copy that
        // follows finds it recorded. Retrying still hands it to the DLQ, as configured.
        if (message.attempts > AI_QUEUE_MAX_RETRIES) {
          log.error("ai.job_dead", fields);
          await recordDeadLetter(db, {
            orgId: job.orgId ?? null,
            threadId: job.threadId,
            queue: batch.queue,
            jobId: job.jobId ?? message.id,
            job: { ...job },
            error: error instanceof Error ? error.message : String(error),
            attempts: message.attempts,
            requestId: job.requestId ?? null,
          }).catch((recordError: unknown) =>
            log.error("ai.dead_letter_not_recorded", { error: recordError }),
          );
        } else {
          log.warn("ai.job_failed", fields);
        }
        // Backoff grows with each attempt; after max_retries the job lands in the DLQ.
        message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 600) });
      }
    }
  } finally {
    await close();
  }
}

export async function runAiJob(
  db: Db,
  models: { triage: TriageClient; summary: ModelClient },
  config: Config,
  job: AiJob,
): Promise<AiJobOutcome> {
  const thread = await loadThreadForAi(db, job.threadId);
  const latest = thread?.messages.at(-1);
  if (!thread || !latest) return "missing";
  // The summary marker moves only after the whole job ran for this message.
  if (thread.summaryMessageId === latest.id) return "done_already";

  // Triage runs on Jev or Claude; summaries only on Claude.
  const triageEnabled = Boolean(config.TYPESAFE_API_KEY || config.ANTHROPIC_API_KEY);
  const summaryEnabled = Boolean(config.ANTHROPIC_API_KEY);
  const isUs = (address: string) => thread.selfAddresses.has(address.toLowerCase());
  const day = new Date().toISOString().slice(0, 10);

  let bucket = thread.triage;
  let triaged = false;
  // The triage describes the latest message. Already done for it (a redelivery, or a retry after
  // the summary failed): reuse it. A newer message, from either side, re-triages, even a thread a
  // person re-sorted. Without a model only the wordless-reply rule can file a thread.
  if (thread.triageMessageId !== latest.id) {
    const input = triageInputFor(thread.messages, isUs);
    const result = triageEnabled ? await triage(models.triage, input) : triageByRule(input);
    if (result) {
      await addAiUsage(db, thread.orgId, day, result.usage);
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
  const nothingNew = triaged ? "triaged" : "done_already";

  // Noise never gets a summary, so the job is complete.
  if (bucket === "noise") {
    await saveSummary(db, thread.id, { summary: null, messageId: latest.id });
    return "triaged";
  }
  if (!summaryEnabled) return nothingNew;

  const decision = shouldSummarize({
    bucket,
    usage: await getAiUsage(db, thread.orgId, day),
    dailyTokenCap: config.AI_DAILY_TOKEN_CAP,
  });
  if (!decision.run) return nothingNew;

  const summary = await summarize(models.summary, {
    subject: latest.subject,
    messages: thread.messages.map((m) => ({
      from: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
      text: m.cleanText,
    })),
  });
  await addAiUsage(db, thread.orgId, day, summary.usage);
  await saveSummary(db, thread.id, { summary: summary.summary, messageId: latest.id });
  return "summarized";
}
