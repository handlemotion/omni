// Smart search: two recalls through `forMember`, then Jev judges how well each candidate fits
// the query (`@omni/ai`) and code decides what shows:
//
// - full-text matches always show, reordered by Jev's judgment;
// - the member's newest threads show only when Jev judges them a match, so "otp" finds "your
//   sign-in code" mail that never says OTP.
//
// Without a TypeSafe key, or when Jev fails or is slow, the full-text order is the answer, so
// search works the same for self-hosters with no AI account.
import { createJevClient, judgeRelevance, rankByRelevance, type SearchCandidate } from "@omni/ai";
import type { MemberQueries, MessageFilters } from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

/** How many of the best full-text candidates Jev judges. The rest keep their text order. */
export const RERANK_CANDIDATES = 30;
/** How many of the member's newest threads Jev also judges, whatever their words. */
export const SEMANTIC_CANDIDATES = 200;
/** Candidates per Jev request; the requests run side by side. */
const JUDGE_BATCH = 100;
/** A thread with none of the query's words shows when Jev finds it more likely a match than not. */
const SEMANTIC_MATCH = 0.5;
/** Past this, the search answers in text order and the Jev call is abandoned. */
const RERANK_BUDGET_MS = 1_500;
/** Judgments are reused this long, e.g. from the popover to the results page for one query. */
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 20_000;

/**
 * Per isolate. Keyed by model, query and matched message, so an entry holds only Jev's judgment
 * of a message for a query: a member reads it only for messages their own search returned.
 */
const judgments = new Map<string, { p: number; expires: number }>();

function cacheKey(model: string, query: string, messageId: string) {
  return `${model}\n${query}\n${messageId}`;
}

function remember(key: string, p: number, now: number) {
  judgments.delete(key);
  judgments.set(key, { p, expires: now + CACHE_TTL_MS });
  // Oldest first: Map keeps insertion order.
  for (const oldest of judgments.keys()) {
    if (judgments.size <= CACHE_MAX_ENTRIES) break;
    judgments.delete(oldest);
  }
}

type Hit = Awaited<ReturnType<MemberQueries["search"]>>[number];

/** The `limit` best threads for `query`, and which ordering produced them. */
export async function smartSearch(
  queries: MemberQueries,
  config: Config,
  query: string,
  options: { mailboxId?: string; limit: number; log: Logger; filters?: MessageFilters },
): Promise<{ hits: Hit[]; ranking: "jev" | "text" }> {
  // Message filters narrow the full-text recall only, so a filtered search stays a word search.
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
  // One word match alone has nothing to be ordered against; one thread that might match by
  // meaning still has to be judged to show at all.
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
      // Not an answer: the text order stands, and the failure is logged.
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
}

function candidate(hit: Hit): SearchCandidate {
  return {
    id: hit.threadId,
    subject: hit.subject,
    from: hit.from,
    sentAt: hit.sentAt,
    mailbox: hit.mailboxAddress,
    messageCount: hit.messageCount,
    excerpt: hit.excerpt,
  };
}
