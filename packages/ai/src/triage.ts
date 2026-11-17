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
    // Room for adaptive thinking ahead of a ~20-token answer.
    maxTokens: 1_024,
  });

  if (!result.ok) return { bucket: "fyi", confidence: 0, source: "fallback", usage: result.usage };
  return { ...result.data, source: "ai", usage: result.usage };
};

/**
 * A customer's message on a shared inbox: the bucket plus priority and tags in one call. Tags are
 * an enum of the inbox's own names, so the model cannot invent one; each maps back to its id.
 */
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
  if (!result.ok) return { bucket: "fyi", confidence: 0, source: "fallback", usage: result.usage };
  const { bucket, confidence, priority } = result.data;
  const tagIds = [...new Set(result.data.tags.map((label) => byLabel.get(label)!))];
  // As on Jev: only a message that waits on the team is handed to anyone.
  const assignee = team.find((t) => t.label === result.data.assignee);
  return {
    bucket,
    confidence,
    source: "ai",
    usage: result.usage,
    helpdesk: {
      priority: bucket === "fyi" || bucket === "noise" ? "low" : priority,
      tagIds,
      assigneeId: bucket === "needs_reply" ? (assignee?.id ?? null) : null,
    },
  };
};

type HelpdeskInput = NonNullable<TriageInput["helpdesk"]>;
