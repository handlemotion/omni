import { z } from "zod";
import { createJevClient, triageWithJev, type JevClient } from "./jev.ts";
import { callStructured } from "./model.ts";
import { triageByRule } from "./policy.ts";
import {
  HELPDESK_TRIAGE_SYSTEM,
  TRIAGE_SYSTEM,
  tagLabel,
  teammatesForPrompt,
  triagePrompt,
} from "./prompt.ts";
import { MAX_SUGGESTED_TAGS, MAX_TAG_QUESTIONS } from "./questions.ts";
import {
  AI_MODEL,
  BUCKETS,
  PRIORITIES,
  type Bucket,
  type CallOptions,
  type ModelClient,
  type TriageInput,
  type TriageResult,
} from "./types.ts";

export const DEFAULT_TRIAGE_INPUT_TOKENS = 1_500;

const NO_LANE = "none";

const TriageOutput = z.object({
  bucket: z.enum([...BUCKETS, NO_LANE]),
  confidence: z.number().min(0).max(1),
});

const SentOutput = z.object({
  bucket: z.enum(["waiting_on_them", NO_LANE]),
  confidence: z.number().min(0).max(1),
});

const laneOf = (answer: Bucket | typeof NO_LANE) => (answer === NO_LANE ? null : answer);

const fallback = (usage: TriageResult["usage"]) =>
  ({ bucket: null, confidence: 0, source: "fallback", usage }) satisfies TriageResult;

/** Jev (judgments plus the truth table) or Claude (one structured call). */
export type TriageClient = JevClient | ModelClient;

/**
 * Sorts a thread into a lane, or into none (`bucket: null`). A reader reply with no words
 * short-circuits to no lane (`triageByRule`); every other thread, including one the reader wrote
 * last, gets a model's judgment. A reader-sent latest message can only become `waiting_on_them`
 * or no lane. API errors throw on either provider, so the queue retries. On Claude, a refusal,
 * truncated answer, or invalid output falls back to no lane at confidence 0, which `laneFor`
 * sends to Unsure; on Jev,
 * judgments the truth table can't settle land below the auto-file threshold.
 */
export const triage: (
  client: TriageClient,
  input: TriageInput,
  options?: CallOptions,
) => Promise<TriageResult> = async (client, input, options = {}) => {
  const byRule = triageByRule(input);
  if (byRule) return byRule;
  if ("provider" in client && client.provider === "jev") return triageWithJev(client, input);
  return triageWithClaude(client as ModelClient, input, options);
};

/**
 * Picks the triage provider from config: `TRIAGE_PROVIDER` when set, otherwise Jev whenever a
 * TypeSafe key is present, otherwise Claude.
 */
export const chooseTriageClient: (config: {
  provider?: "jev" | "claude";
  typesafeApiKey?: string;
  jevModel?: string;
  typesafeApiUrl?: string;
  anthropic: ModelClient;
}) => TriageClient = (config) => {
  const provider = config.provider ?? (config.typesafeApiKey ? "jev" : "claude");
  if (provider === "claude") return config.anthropic;
  if (!config.typesafeApiKey) throw new Error("TRIAGE_PROVIDER=jev needs TYPESAFE_API_KEY");
  return createJevClient({
    apiKey: config.typesafeApiKey,
    model: config.jevModel,
    baseUrl: config.typesafeApiUrl,
  });
};

const triageWithClaude: (
  client: ModelClient,
  input: TriageInput,
  options: CallOptions,
) => Promise<TriageResult> = async (client, input, options) => {
  const model = options.model ?? AI_MODEL;
  const user = triagePrompt(input, options.maxInputTokens ?? DEFAULT_TRIAGE_INPUT_TOKENS);
  if (input.helpdesk && !input.latestFromUs) {
    return triageHelpdeskWithClaude(client, input.helpdesk, model, user);
  }
  const result = await callStructured(client, {
    model,
    system: TRIAGE_SYSTEM,
    user,
    schema: input.latestFromUs ? SentOutput : TriageOutput,
    maxTokens: 1_024,
  });

  if (!result.ok) return fallback(result.usage);
  const { bucket, confidence } = result.data;
  return { bucket: laneOf(bucket), confidence, source: "ai", usage: result.usage };
};

const triageHelpdeskWithClaude: (
  client: ModelClient,
  helpdesk: HelpdeskInput,
  model: string,
  user: string,
) => Promise<TriageResult> = async (client, helpdesk, model, user) => {
  const byLabel = new Map(
    helpdesk.tags.slice(0, MAX_TAG_QUESTIONS).map((t) => [tagLabel(t.name), t.id]),
  );
  const labels = [...byLabel.keys()];
  const team = teammatesForPrompt(helpdesk.teammates);
  const schema = TriageOutput.extend({
    priority: z.enum(PRIORITIES),
    tags: labels.length
      ? z.array(z.enum(labels as [string, ...string[]])).max(MAX_SUGGESTED_TAGS)
      : z.array(z.string()).max(0),
    assignee: z.enum(["none", ...team.map((t) => t.label)]),
  });
  const result = await callStructured(client, {
    model,
    system: HELPDESK_TRIAGE_SYSTEM,
    user,
    schema,
    maxTokens: 1_024,
  });
  if (!result.ok) return fallback(result.usage);
  const { confidence, priority } = result.data;
  const bucket = laneOf(result.data.bucket);
  const tagIds = [...new Set(result.data.tags.map((label) => byLabel.get(label)!))];
  const assignee = team.find((t) => t.label === result.data.assignee);
  return {
    bucket,
    confidence,
    source: "ai",
    usage: result.usage,
    helpdesk: {
      priority: bucket === null || bucket === "noise" ? "low" : priority,
      tagIds,
      assigneeId: bucket === "needs_reply" ? (assignee?.id ?? null) : null,
    },
  };
};

type HelpdeskInput = NonNullable<TriageInput["helpdesk"]>;
