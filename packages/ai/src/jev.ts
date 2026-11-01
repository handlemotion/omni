// TypeSafe's Jev over plain fetch, so it runs in a Worker with no Node APIs. One request per
// thread: the state below plus every question in `questions.ts`, answered in parallel.

import { z } from "zod";
import { decide, type Judgments } from "./decide.ts";
import { truncateToTokens } from "./policy.ts";
import {
  JEV_EARLIER_MESSAGE_TOKENS,
  JEV_EARLIER_MESSAGES,
  JEV_LATEST_MESSAGE_TOKENS,
  JEV_MODEL,
  JUDGMENTS,
  READER_NOTE,
  TRIAGE_QUESTIONS,
} from "./questions.ts";
import type { TriageInput, TriageResult } from "./types.ts";

export const TYPESAFE_API_URL = "https://api.typesafe.ai";
const TIMEOUT_MS = 20_000;

export interface JevClient {
  provider: "jev";
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch: typeof fetch;
}

export function createJevClient(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): JevClient {
  return {
    provider: "jev",
    apiKey: options.apiKey,
    model: options.model ?? JEV_MODEL,
    baseUrl: options.baseUrl ?? TYPESAFE_API_URL,
    // Bound so a Worker's global fetch keeps its `this`.
    fetch: options.fetch ?? ((...args) => fetch(...args)),
  };
}

/** A failed Jev call. Thrown, never turned into an answer, so the queue retries the job. */
export class JevError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

/**
 * What a person would look at to sort the thread. Built field by field from the spec's triage
 * inputs: never HTML, attachments, or anything else the caller's object happens to carry.
 * Untrusted text only ever lands in string values, so JSON escaping keeps it from forging keys.
 */
export function triageState(input: TriageInput) {
  const list = input.list ?? {};
  const earlier = (input.earlierMessages ?? []).slice(-JEV_EARLIER_MESSAGES);
  // Absent facts are left out rather than sent as null or [], which the model could read as a
  // signal.
  return {
    reader_note: READER_NOTE,
    sender: input.from.name
      ? { name: input.from.name, address: input.from.address }
      : { address: input.from.address },
    subject: input.subject,
    latest_message: truncateToTokens(input.latestText, JEV_LATEST_MESSAGE_TOKENS),
    thread: {
      message_count: input.messageCount,
      reader_has_replied_before: input.repliedBefore,
      ...(earlier.length > 0 && {
        earlier_messages: earlier.map((m) => ({
          from: m.fromUs ? "the reader" : m.from,
          text: truncateToTokens(m.text, JEV_EARLIER_MESSAGE_TOKENS),
        })),
      }),
    },
    mail_headers: {
      has_list_unsubscribe: list.listUnsubscribe ?? false,
      ...(list.listId && { list_id: list.listId }),
      ...(list.precedence && { precedence: list.precedence }),
      ...(list.autoSubmitted && { auto_submitted: list.autoSubmitted }),
    },
  };
}

/** The exact body sent to `POST /v1/systemone`. Exported so callers can log or replay it. */
export function jevTriageRequest(input: TriageInput, model = JEV_MODEL) {
  return { model, state: triageState(input), questions: TRIAGE_QUESTIONS };
}

const NoulAnswer = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) });
const SystemOneResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

async function ask(client: JevClient, body: unknown) {
  let response: Response;
  try {
    response = await client.fetch(`${client.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${client.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new JevError(`TypeSafe request failed: ${String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new JevError(`TypeSafe returned ${response.status}: ${detail}`, response.status);
  }
  const parsed = SystemOneResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new JevError("TypeSafe returned an unexpected response body");
  return parsed.data;
}

/** Triage through Jev's judgments and the truth table. Errors throw; there is no fallback. */
export async function triageWithJev(client: JevClient, input: TriageInput): Promise<TriageResult> {
  const response = await ask(client, jevTriageRequest(input, client.model));
  const judgments = {} as Judgments;
  for (const judgment of JUDGMENTS) {
    const answer = NoulAnswer.safeParse(response.answers[judgment]);
    if (!answer.success) throw new JevError(`TypeSafe gave no Noul answer for ${judgment}`);
    judgments[judgment] = answer.data.noul;
  }
  const { bucket, confidence } = decide(judgments);
  return {
    bucket,
    confidence,
    source: "ai",
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
    model: response.model,
  };
}
