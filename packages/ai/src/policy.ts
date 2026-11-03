// Pure decisions around the model: when to skip it, where its answer lands, what it may see.

import { NO_USAGE, type Bucket, type TriageInput, type TriageResult } from "./types.ts";

export const DEFAULT_AUTO_FILE_THRESHOLD = 0.85;

/**
 * Conservative chars-per-token estimate for budgeting untrusted text. Real tokenizers average
 * closer to 4 for English, so this errs toward sending less.
 */
const CHARS_PER_TOKEN = 3;
const TRUNCATION_MARKER = "\n[truncated]";

/**
 * The one case code settles without a model: the reader replied with no words at all (an empty
 * body, a lone "👍", only an attachment). Such a reply asks nothing, so the thread is `fyi`. A
 * first message is left to the model, since its subject may carry the ask. Everything else,
 * including every other reader-sent message, needs a judgment.
 */
export function triageByRule(input: TriageInput): TriageResult | null {
  if (input.latestFromUs && input.messageCount > 1 && !/[\p{L}\p{N}]/u.test(input.latestText)) {
    return { bucket: "fyi", confidence: 1, source: "rule", usage: NO_USAGE };
  }
  return null;
}

export type Lane = Bucket | "unsure";

/** Auto-file at or above the threshold; everything else goes to the Unsure lane for a person. */
export function laneFor(
  result: Pick<TriageResult, "bucket" | "confidence" | "source">,
  threshold = DEFAULT_AUTO_FILE_THRESHOLD,
): Lane {
  if (result.source === "rule") return result.bucket;
  if (result.source === "fallback") return "unsure";
  return result.confidence >= threshold ? result.bucket : "unsure";
}

/** The org's `ai_usage` row for today. */
export interface DailyUsage {
  tokensIn: number;
  tokensOut: number;
}

export function isOverDailyCap(usage: DailyUsage, dailyTokenCap: number): boolean {
  return usage.tokensIn + usage.tokensOut >= dailyTokenCap;
}

export type SummaryDecision = { run: true } | { run: false; reason: "noise" | "over_cap" };

/** Summaries skip noise and pause over the daily cap. Triage ignores the cap. */
export function shouldSummarize(input: {
  bucket: Bucket;
  usage: DailyUsage;
  dailyTokenCap: number;
}): SummaryDecision {
  if (input.bucket === "noise") return { run: false, reason: "noise" };
  if (isOverDailyCap(input.usage, input.dailyTokenCap)) return { run: false, reason: "over_cap" };
  return { run: true };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Cuts text to roughly `maxTokens`, at a word boundary when one is near, and marks the cut. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length));
  // Never leave half a surrogate pair at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  if (space > cut.length * 0.8) cut = cut.slice(0, space);
  return cut.trimEnd() + TRUNCATION_MARKER;
}

const MAX_SUMMARY_CHARS = 600;

/**
 * Model output is shown as plain text, never HTML. Strips tags, control characters, and
 * markdown emphasis, collapses whitespace, and caps the length. Returns null if nothing is left.
 */
export function toPlainText(text: string, maxChars = MAX_SUMMARY_CHARS): string | null {
  const plain = text
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  return (space > maxChars * 0.8 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
