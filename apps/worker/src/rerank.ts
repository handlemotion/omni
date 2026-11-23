import { createJevClient } from "@omni/ai";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

/** The probability at or above which an item found only by meaning counts as a match. */
export const MEANING_MATCH = 0.5;
const JUDGE_BATCH = 100;
const BUDGET_MS = 1_500;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 20_000;

type JevClient = ReturnType<typeof createJevClient>;

export interface JudgePolicy<T> {
  judge: (
    client: JevClient,
    query: string,
    batch: T[],
    options: { now: Date; signal: AbortSignal },
  ) => Promise<{ relevance: ReadonlyMap<string, number> }>;
  /** The id Jev answers by, and the key of the returned relevance map. */
  idOf: (item: T) => string;
  /** What makes a cached judgment stale besides the model and the query, e.g. a content version. */
  keyOf: (item: T) => string;
  /** Names the warning logged when Jev fails or runs out of time. */
  event: string;
  component: string;
}

/**
 * A Jev judge with its own short-lived cache. It returns each item's relevance by `idOf`, judging
 * the uncached ones in parallel batches within one time budget, or null when Jev fails or is slow
 * so the caller falls back to text order.
 */
export function cachedJudge<T>(policy: JudgePolicy<T>) {
  const judgments = new Map<string, { p: number; expires: number }>();

  function remember(key: string, p: number, now: number) {
    judgments.delete(key);
    judgments.set(key, { p, expires: now + CACHE_TTL_MS });
    for (const oldest of judgments.keys()) {
      if (judgments.size <= CACHE_MAX_ENTRIES) break;
      judgments.delete(oldest);
    }
  }

  return async (config: Config, query: string, pool: readonly T[], log: Logger) => {
    const client = createJevClient({
      apiKey: config.TYPESAFE_API_KEY!,
      model: config.JEV_MODEL,
      baseUrl: config.TYPESAFE_API_URL,
    });
    const cacheKey = (item: T) => `${client.model}\n${query}\n${policy.keyOf(item)}`;
    const now = Date.now();
    const relevance = new Map<string, number>();
    const unjudged: T[] = [];
    for (const item of pool) {
      const cached = judgments.get(cacheKey(item));
      if (cached && cached.expires > now) relevance.set(policy.idOf(item), cached.p);
      else unjudged.push(item);
    }
    if (!unjudged.length) return relevance;
    try {
      const signal = AbortSignal.timeout(BUDGET_MS);
      const batches: T[][] = [];
      for (let i = 0; i < unjudged.length; i += JUDGE_BATCH) {
        batches.push(unjudged.slice(i, i + JUDGE_BATCH));
      }
      const judged = await Promise.all(
        batches.map((batch) => policy.judge(client, query, batch, { now: new Date(now), signal })),
      );
      batches.forEach((batch, i) => {
        for (const item of batch) {
          const p = judged[i]!.relevance.get(policy.idOf(item))!;
          relevance.set(policy.idOf(item), p);
          remember(cacheKey(item), p, now);
        }
      });
      return relevance;
    } catch (error) {
      log.warn(policy.event, {
        component: policy.component,
        error: error instanceof Error ? error.message : String(error),
        candidates: unjudged.length,
        durationMs: Date.now() - now,
      });
      return null;
    }
  };
}
