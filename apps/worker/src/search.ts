import { createJevClient, judgeRelevance, rankByRelevance, type SearchCandidate } from "@omni/ai";
import type { MemberQueries, MessageFilters } from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

/** How many of the best full-text candidates Jev judges. The rest keep their text order. */
export const RERANK_CANDIDATES = 30;
/** How many of the member's newest threads Jev also judges, whatever their words. */
export const SEMANTIC_CANDIDATES = 200;
const JUDGE_BATCH = 100;
const SEMANTIC_MATCH = 0.5;
const RERANK_BUDGET_MS = 1_500;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 20_000;

const judgments = new Map<string, { p: number; expires: number }>();

function cacheKey(model: string, query: string, messageId: string) {
  return `${model}\n${query}\n${messageId}`;
}

function remember(key: string, p: number, now: number) {
  judgments.delete(key);
  judgments.set(key, { p, expires: now + CACHE_TTL_MS });
  for (const oldest of judgments.keys()) {
    if (judgments.size <= CACHE_MAX_ENTRIES) break;
    judgments.delete(oldest);
  }
}

type Hit = Awaited<ReturnType<MemberQueries["search"]>>[number];

/** The `limit` best threads for `query`, and which ordering produced them. */
export const smartSearch: (
  queries: MemberQueries,
  config: Config,
  query: string,
  options: { mailboxId?: string; limit: number; log: Logger; filters?: MessageFilters },
) => Promise<{ hits: Hit[]; ranking: "jev" | "text" }> = async (
  queries,
  config,
  query,
  options,
) => {
  const [hits, recent] = await Promise.all([
    queries.search(query, {
      mailboxId: options.mailboxId,
      filters: options.filters,
      limit: Math.max(options.limit, RERANK_CANDIDATES),
    }),
    config.TYPESAFE_API_KEY && !options.filters
      ? queries.searchRecent({ mailboxId: options.mailboxId, limit: SEMANTIC_CANDIDATES })
      : [],
  ]);
  const text = { hits: hits.slice(0, options.limit), ranking: "text" as const };
  const matched = new Set(hits.map((hit) => hit.threadId));
  const unmatched = recent.filter((hit) => !matched.has(hit.threadId));
  const pool = [...hits.slice(0, RERANK_CANDIDATES), ...unmatched];
  if (!config.TYPESAFE_API_KEY || (pool.length < 2 && !unmatched.length)) return text;

  const client = createJevClient({
    apiKey: config.TYPESAFE_API_KEY,
    model: config.JEV_MODEL,
    baseUrl: config.TYPESAFE_API_URL,
  });
  const now = Date.now();
  const relevance = new Map<string, number>();
  const unjudged: Hit[] = [];
  for (const hit of pool) {
    const cached = judgments.get(cacheKey(client.model, query, hit.messageId));
    if (cached && cached.expires > now) relevance.set(hit.threadId, cached.p);
    else unjudged.push(hit);
  }

  if (unjudged.length) {
    try {
      const signal = AbortSignal.timeout(RERANK_BUDGET_MS);
      const batches: Hit[][] = [];
      for (let i = 0; i < unjudged.length; i += JUDGE_BATCH) {
        batches.push(unjudged.slice(i, i + JUDGE_BATCH));
      }
      const judged = await Promise.all(
        batches.map((batch) =>
          judgeRelevance(client, query, batch.map(candidate), { now: new Date(now), signal }),
        ),
      );
      batches.forEach((batch, i) => {
        for (const hit of batch) {
          const p = judged[i]!.relevance.get(hit.threadId)!;
          relevance.set(hit.threadId, p);
          remember(cacheKey(client.model, query, hit.messageId), p, now);
        }
      });
    } catch (error) {
      options.log.warn("search.rerank_failed", {
        component: "search",
        error: error instanceof Error ? error.message : String(error),
        candidates: unjudged.length,
        durationMs: Date.now() - now,
      });
      return text;
    }
  }

  const byMeaning = unmatched.filter((hit) => (relevance.get(hit.threadId) ?? 0) >= SEMANTIC_MATCH);
  const ranked = rankByRelevance(
    [...hits, ...byMeaning].map((hit) => ({ ...hit, id: hit.threadId })),
    relevance,
  );
  return { hits: ranked.slice(0, options.limit), ranking: "jev" };
};

function candidate(hit: Hit) {
  return {
    id: hit.threadId,
    subject: hit.subject,
    from: hit.from,
    sentAt: hit.sentAt,
    mailbox: hit.mailboxAddress,
    messageCount: hit.messageCount,
    excerpt: hit.excerpt,
  } satisfies SearchCandidate;
}
