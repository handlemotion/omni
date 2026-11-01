// AI queue consumer: triage and summary for a thread after new mail. A job names only the
// thread; the consumer reads its current state, so a redelivered or duplicate job converges on
// the same result and a job finished once is skipped without a model call.
import Anthropic from "@anthropic-ai/sdk";
import { shouldSummarize, summarize, triage, type ModelClient } from "@omni/ai";
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

export type AiJob = { kind: "thread"; threadId: string };

export type AiJobOutcome = "missing" | "done_already" | "no_model" | "triaged" | "summarized";

export async function consumeAiQueue(batch: MessageBatch<AiJob>, env: Env) {
  const config = loadConfig(env);
  // With no key the client is never called: only the ours-last rule runs (see runAiJob).
  const model = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? null });
  const { db, close } = createDb(env.HYPERDRIVE.connectionString, {
    max: 2,
    fetch_types: false,
    onnotice: () => {},
  });
  try {
    for (const message of batch.messages) {
      try {
        const outcome = await runAiJob(db, model, config, message.body);
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
  model: ModelClient,
  config: Config,
  job: AiJob,
): Promise<AiJobOutcome> {
  const thread = await loadThreadForAi(db, job.threadId);
  const latest = thread?.messages.at(-1);
  if (!thread || !latest) return "missing";
  // The summary marker moves only after the whole job ran for this message.
  if (thread.summaryMessageId === latest.id) return "done_already";

  const aiEnabled = Boolean(config.ANTHROPIC_API_KEY);
  const isUs = (address: string) => thread.selfAddresses.has(address.toLowerCase());
  const latestFromUs = isUs(latest.fromAddress);
  const day = new Date().toISOString().slice(0, 10);

  let bucket = thread.triage;
  // A person's re-sort is final. Without a model only the ours-last rule can file a thread, and
  // `triage` short-circuits it without a call.
  if (thread.triageSource !== "person" && (aiEnabled || latestFromUs)) {
    const result = await triage(model, {
      from: { name: latest.fromName, address: latest.fromAddress },
      subject: latest.subject,
      latestText: latest.cleanText,
      latestFromUs,
      messageCount: thread.messages.length,
      repliedBefore: thread.messages.slice(0, -1).some((m) => isUs(m.fromAddress)),
    });
    await addAiUsage(db, thread.orgId, day, result.usage);
    // Lanes are derived on read: below the auto-file confidence a thread shows in Unsure.
    await saveTriage(db, thread.id, { bucket: result.bucket, confidence: result.confidence });
    bucket = result.bucket;
  }
  if (!bucket) return "no_model";

  // Noise never gets a summary, so the job is complete.
  if (bucket === "noise") {
    await saveSummary(db, thread.id, { summary: null, messageId: latest.id });
    return "triaged";
  }
  if (!aiEnabled) return "triaged";

  const decision = shouldSummarize({
    bucket,
    usage: await getAiUsage(db, thread.orgId, day),
    dailyTokenCap: config.AI_DAILY_TOKEN_CAP,
  });
  if (!decision.run) return "triaged";

  const summary = await summarize(model, {
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
