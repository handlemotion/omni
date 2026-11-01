import { z } from "zod";
import { callStructured } from "./model.ts";
import { toPlainText } from "./policy.ts";
import { SUMMARY_SYSTEM, summaryPrompt } from "./prompt.ts";
import {
  AI_MODEL,
  type CallOptions,
  type ModelClient,
  type SummarizeInput,
  type SummaryResult,
} from "./types.ts";

export const DEFAULT_SUMMARY_INPUT_TOKENS = 3_000;

const SummaryOutput = z.object({ summary: z.string() });

/**
 * One to three plain-text sentences for the top of a thread. Check `shouldSummarize` first:
 * noise and over-cap orgs skip this call. Unusable output returns `summary: null`.
 */
export async function summarize(
  client: ModelClient,
  input: SummarizeInput,
  options: CallOptions = {},
): Promise<SummaryResult> {
  const result = await callStructured(client, {
    model: options.model ?? AI_MODEL,
    system: SUMMARY_SYSTEM,
    user: summaryPrompt(input, options.maxInputTokens ?? DEFAULT_SUMMARY_INPUT_TOKENS),
    schema: SummaryOutput,
    maxTokens: 2_048,
  });

  const summary = result.ok ? toPlainText(result.data.summary) : null;
  return summary === null
    ? { summary: null, source: "fallback", usage: result.usage }
    : { summary, source: "ai", usage: result.usage };
}
