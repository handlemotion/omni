import type Anthropic from "@anthropic-ai/sdk";

export const AI_MODEL = "claude-haiku-5-5";

export const BUCKETS = ["needs_reply", "waiting_on_them", "fyi", "noise"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The Worker passes a real `Anthropic` instance; only `messages` is used. */
export type ModelClient = Pick<Anthropic, "messages">;

/** Tokens one call spent. Add these to the org's `ai_usage` row for the day. */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0 };

/** Signals from list and automation headers. All optional; absent means not present. */
export interface ListSignals {
  listUnsubscribe?: boolean;
  listId?: string | null;
  precedence?: string | null;
  autoSubmitted?: string | null;
}

/** Triage input: the spec's fields only. Never attachments or HTML. */
export interface TriageInput {
  from: { name?: string | null; address: string };
  subject: string;
  /** `clean_text` of the latest message. Truncated to the token budget before it is sent. */
  latestText: string;
  /** The latest message was sent from one of our mailboxes. */
  latestFromUs: boolean;
  messageCount: number;
  /** We have replied in this thread before. */
  repliedBefore: boolean;
  list?: ListSignals;
}

export type TriageSource = "rule" | "ai" | "fallback";

export interface TriageResult {
  bucket: Bucket;
  /** 0..1. Rule results are 1; fallbacks are 0, so they always land in Unsure. */
  confidence: number;
  /**
   * `rule`: decided without the model. `ai`: the model's validated answer. `fallback`: the model
   * refused, ran out of tokens, or returned invalid output. All three store as
   * `threads.triage_source = 'ai'`; only a person's re-sort stores `'person'`.
   */
  source: TriageSource;
  usage: Usage;
}

export interface SummarizeInput {
  subject: string;
  /** Oldest first. `text` is each message's `clean_text`. The newest fit the token budget. */
  messages: ReadonlyArray<{ from: string; text: string }>;
}

export interface SummaryResult {
  /** Plain text, 1-3 sentences. Null when the model gave nothing usable. */
  summary: string | null;
  source: "ai" | "fallback";
  usage: Usage;
}

export interface CallOptions {
  model?: string;
  /** Token budget for untrusted email text in the prompt. */
  maxInputTokens?: number;
}
