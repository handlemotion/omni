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
export const triageByRule: (input: TriageInput) => TriageResult | null = (input) => {
  if (input.latestFromUs && input.messageCount > 1 && !/[\p{L}\p{N}]/u.test(input.latestText)) {
    return { bucket: "fyi", confidence: 1, source: "rule", usage: NO_USAGE };
  }
  return null;
};

export type Lane = Bucket | "unsure";

/** Auto-file at or above the threshold; everything else goes to the Unsure lane for a person. */
export function laneFor(
  result: Pick<TriageResult, "bucket" | "confidence" | "source">,
  threshold = DEFAULT_AUTO_FILE_THRESHOLD,
) {
  if (result.source === "rule") return result.bucket satisfies Lane;
  if (result.source === "fallback") return "unsure" satisfies Lane;
  return (result.confidence >= threshold ? result.bucket : "unsure") satisfies Lane;
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Cuts text to roughly `maxTokens`, at a word boundary when one is near, and marks the cut. */
export function truncateToTokens(text: string, maxTokens: number) {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length));
  // Never leave half a surrogate pair at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  if (space > cut.length * 0.8) cut = cut.slice(0, space);
  return cut.trimEnd() + TRUNCATION_MARKER;
}

/**
 * The usage month holding `now` for a triage allowance anchored at `anchor` (the subscription's
 * period start; ADR 0015). Months step from the anchor the way Stripe bills monthly: same day and
 * time, clamped to the month's last day (a Jan 31 anchor gives Feb 28, then Mar 31). A yearly
 * plan's allowance is monthly too, so it resets twelve times between invoices.
 */
export const usageMonth: (anchor: Date, now: Date) => { start: Date; end: Date } = (
  anchor,
  now,
) => {
  let k =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  if (addMonths(anchor, k) > now) k -= 1;
  else if (addMonths(anchor, k + 1) <= now) k += 1;
  return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
};

function addMonths(anchor: Date, months: number) {
  const total = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  ) satisfies Date;
}

/**
 * The window a workspace's triage allowance counts in. Inside a monthly billing period it is that
 * period, exactly as Stripe set it. Otherwise (a yearly plan, or a renewal whose webhook has not
 * landed yet) it is the `usageMonth` stepped from the period start.
 */
export const usagePeriod: (
  billing: { periodStart: Date; periodEnd: Date | null; interval: string | null },
  now: Date,
) => { start: Date; end: Date } = (billing, now) => {
  const { periodStart, periodEnd, interval } = billing;
  if (interval !== "year" && periodEnd && periodStart <= now && now < periodEnd) {
    return { start: periodStart, end: periodEnd };
  }
  return usageMonth(periodStart, now);
};
