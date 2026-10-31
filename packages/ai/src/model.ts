import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { ModelClient, Usage } from "./types.ts";

export type StructuredResult<T> =
  | { ok: true; data: T; usage: Usage }
  | { ok: false; reason: "refusal" | "max_tokens" | "invalid_output"; usage: Usage };

/**
 * One structured-output call. No tools are offered, so the model can only answer in `schema`.
 * Output that fails the schema becomes `invalid_output` with usage kept, so the caller still
 * records what it spent. API and network errors throw, so the queue retries the job.
 */
export async function callStructured<S extends z.ZodType>(
  client: ModelClient,
  request: { model: string; system: string; user: string; schema: S; maxTokens: number },
): Promise<StructuredResult<z.infer<S>>> {
  const format = zodOutputFormat(request.schema);
  const message = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    // Haiku 5.5 thinks adaptively by default; low effort keeps classification cheap.
    output_config: { effort: "low", format },
    system: request.system,
    messages: [{ role: "user", content: request.user }],
  });

  const usage = usageOf(message);
  if (message.stop_reason === "refusal") return { ok: false, reason: "refusal", usage };
  if (message.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens", usage };

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  try {
    return { ok: true, data: format.parse(text), usage };
  } catch {
    return { ok: false, reason: "invalid_output", usage };
  }
}

function usageOf(message: Anthropic.Message): Usage {
  const u = message.usage;
  return {
    tokensIn:
      u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    tokensOut: u.output_tokens,
  };
}
