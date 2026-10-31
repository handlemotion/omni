import { z } from "zod";
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

/**
 * Sorts a thread into a bucket. Ours-last threads short-circuit to `waiting_on_them`. A refusal,
 * truncated answer, or invalid output falls back to `fyi` at confidence 0, which `laneFor` sends
 * to Unsure. API errors throw.
 */
export async function triage(
  client: ModelClient,
  input: TriageInput,
  options: CallOptions = {},
): Promise<TriageResult> {
  const byRule = triageByRule(input);
  if (byRule) return byRule;

  const result = await callStructured(client, {
    model: options.model ?? AI_MODEL,
    system: TRIAGE_SYSTEM,
    user: triagePrompt(input, options.maxInputTokens ?? DEFAULT_TRIAGE_INPUT_TOKENS),
    schema: TriageOutput,
    // Room for adaptive thinking ahead of a ~20-token answer.
    maxTokens: 1_024,
  });

  if (!result.ok) return { bucket: "fyi", confidence: 0, source: "fallback", usage: result.usage };
  return { ...result.data, source: "ai", usage: result.usage };
}
