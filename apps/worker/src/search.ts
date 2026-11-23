import { judgeRelevance, rankByRelevance, type SearchCandidate } from "@omni/ai";
import type { MemberQueries, MessageFilters } from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";
import { cachedJudge, MEANING_MATCH } from "./rerank.ts";

/** How many of the best full-text candidates Jev judges. The rest keep their text order. */
export const RERANK_CANDIDATES = 30;
/** How many of the member's newest threads Jev also judges, whatever their words. */
export const SEMANTIC_CANDIDATES = 200;

type Hit = Awaited<ReturnType<MemberQueries["search"]>>[number];

const judge = cachedJudge<Hit>({
  judge: (client, query, batch, options) =>
    judgeRelevance(client, query, batch.map(candidate), options),
  idOf: (hit) => hit.threadId,
  keyOf: (hit) => hit.messageId,
  event: "search.rerank_failed",
  component: "search",
});

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

  const relevance = await judge(config, query, pool, options.log);
  if (!relevance) return text;
  const byMeaning = unmatched.filter((hit) => (relevance.get(hit.threadId) ?? 0) >= MEANING_MATCH);
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
