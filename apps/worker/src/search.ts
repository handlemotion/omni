// Smart search: Postgres full-text recall through `forMember`, then Jev judges how well the best
// candidates fit the query and they are reordered by that judgment (`@omni/ai`). Without a
// TypeSafe key, or when Jev fails or is slow, the full-text order is the answer, so search works
// the same for self-hosters with no AI account.
import { createJevClient, judgeRelevance, rankByRelevance, type SearchCandidate } from "@omni/ai";
import type { MemberQueries } from "@omni/db";
import type { Config } from "./env.ts";

/** How many of the best full-text candidates Jev judges. The rest keep their text order. */
export const RERANK_CANDIDATES = 30;
/** Past this, the search answers in text order and the Jev call is abandoned. */
const RERANK_BUDGET_MS = 1_500;
/** Judgments are reused this long, e.g. from the popover to the results page for one query. */
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 5_000;

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
  options: { mailboxId?: string; limit: number },
): Promise<{ hits: Hit[]; ranking: "jev" | "text" }> {
  const hits = await queries.search(query, {
    mailboxId: options.mailboxId,
    limit: Math.max(options.limit, RERANK_CANDIDATES),
  });
  const text = { hits: hits.slice(0, options.limit), ranking: "text" as const };
  if (!config.TYPESAFE_API_KEY || hits.length < 2) return text;

  const client = createJevClient({
    apiKey: config.TYPESAFE_API_KEY,
    model: config.JEV_MODEL,
    baseUrl: config.TYPESAFE_API_URL,
  });
  const now = Date.now();
  const top = hits.slice(0, RERANK_CANDIDATES);
  const relevance = new Map<string, number>();
  const unjudged: Hit[] = [];
  for (const hit of top) {
    const cached = judgments.get(cacheKey(client.model, query, hit.messageId));
    if (cached && cached.expires > now) relevance.set(hit.threadId, cached.p);
    else unjudged.push(hit);
  }

  if (unjudged.length) {
    try {
      const judged = await judgeRelevance(client, query, unjudged.map(candidate), {
        now: new Date(now),
        signal: AbortSignal.timeout(RERANK_BUDGET_MS),
      });
      for (const hit of unjudged) {
        const p = judged.relevance.get(hit.threadId)!;
        relevance.set(hit.threadId, p);
        remember(cacheKey(client.model, query, hit.messageId), p, now);
      }
    } catch (error) {
      // Not an answer: the text order stands, and the failure is logged.
      // oxlint-disable-next-line no-console -- one structured line per failed rerank
      console.log(
        JSON.stringify({
          event: "search.rerank_failed",
          error: error instanceof Error ? error.message : String(error),
          candidates: unjudged.length,
          ms: Date.now() - now,
        }),
      );
      return text;
    }
  }

  const ranked = rankByRelevance(
    hits.map((hit) => ({ ...hit, id: hit.threadId })),
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
