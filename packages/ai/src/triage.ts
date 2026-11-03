import { z } from "zod";
import { createJevClient, triageWithJev, type JevClient } from "./jev.ts";
import { callStructured } from "./model.ts";
import { triageByRule } from "./policy.ts";
import { TRIAGE_SYSTEM, triagePrompt } from "./prompt.ts";
import {
  AI_MODEL,
  BUCKETS,
  type CallOptions,
  type ModelClient,
  type TriageInput,
  type TriageResult,
} from "./types.ts";

export const DEFAULT_TRIAGE_INPUT_TOKENS = 1_500;

const TriageOutput = z.object({
  bucket: z.enum(BUCKETS),
  confidence: z.number().min(0).max(1),
});

/** The reader wrote last: someone else can't be waiting on them, so `needs_reply` is off the table. */
const SentOutput = z.object({
  bucket: z.enum(["waiting_on_them", "fyi"]),
  confidence: z.number().min(0).max(1),
});

/** Jev (judgments plus the truth table) or Claude (one structured call). */
export type TriageClient = JevClient | ModelClient;

/**
 * Sorts a thread into a bucket. A reader reply with no words short-circuits to `fyi`
 * (`triageByRule`); every other thread, including one the reader wrote last, gets a model's
 * judgment. A reader-sent latest message can only become `waiting_on_them` or `fyi`. API errors
 * throw on either provider, so the queue retries. On Claude, a refusal, truncated answer, or
 * invalid output falls back to `fyi` at confidence 0, which `laneFor` sends to Unsure; on Jev,
 * judgments the truth table can't settle land below the auto-file threshold.
 */
export async function triage(
  client: TriageClient,
  input: TriageInput,
  options: CallOptions = {},
): Promise<TriageResult> {
  const byRule = triageByRule(input);
  if (byRule) return byRule;
  if ("provider" in client && client.provider === "jev") return triageWithJev(client, input);
  return triageWithClaude(client as ModelClient, input, options);
}

/**
 * Picks the triage provider from config: `TRIAGE_PROVIDER` when set, otherwise Jev whenever a
 * TypeSafe key is present, otherwise Claude.
 */
export function chooseTriageClient(config: {
  provider?: "jev" | "claude";
  typesafeApiKey?: string;
  jevModel?: string;
  typesafeApiUrl?: string;
  anthropic: ModelClient;
}): TriageClient {
  const provider = config.provider ?? (config.typesafeApiKey ? "jev" : "claude");
  if (provider === "claude") return config.anthropic;
  if (!config.typesafeApiKey) throw new Error("TRIAGE_PROVIDER=jev needs TYPESAFE_API_KEY");
  return createJevClient({
    apiKey: config.typesafeApiKey,
    model: config.jevModel,
    baseUrl: config.typesafeApiUrl,
  });
}

async function triageWithClaude(
  client: ModelClient,
  input: TriageInput,
  options: CallOptions,
): Promise<TriageResult> {
  const result = await callStructured(client, {
    model: options.model ?? AI_MODEL,
    system: TRIAGE_SYSTEM,
    user: triagePrompt(input, options.maxInputTokens ?? DEFAULT_TRIAGE_INPUT_TOKENS),
    schema: input.latestFromUs ? SentOutput : TriageOutput,
    // Room for adaptive thinking ahead of a ~20-token answer.
    maxTokens: 1_024,
  });

  if (!result.ok) return { bucket: "fyi", confidence: 0, source: "fallback", usage: result.usage };
  return { ...result.data, source: "ai", usage: result.usage };
}
