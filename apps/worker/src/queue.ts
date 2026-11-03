// AI queue consumer: triage and summary for a thread after new mail, in either direction. A job
// names only the thread; the consumer reads its current state and triages the latest message, so
// a redelivered or duplicate job converges on the same result, and work already done for that
// message (`triage_message_id`, `summary_message_id`) is skipped without a model call.
import Anthropic from "@anthropic-ai/sdk";
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
  saveSummary,
  saveTriage,
  type Db,
} from "@omni/db";
import { loadConfig, type Config } from "./env.ts";
import { fanOut } from "./realtime.ts";

export type AiJob = { kind: "thread"; threadId: string; mailboxId: string };

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
      try {
        const outcome = await runAiJob(db, models, config, message.body);
        if (outcome === "triaged" || outcome === "summarized") {
          const { mailboxId, threadId } = message.body;
          await fanOut(env, db, config, new Map([[mailboxId, new Set([threadId])]]));
        }
        // oxlint-disable-next-line no-console -- one structured line per job
        console.log(JSON.stringify({ event: "ai.job", threadId: message.body.threadId, outcome }));
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "ai.job_failed",
            threadId: message.body.threadId,
            attempts: message.attempts,
            error: String(error),
          }),
        );
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
