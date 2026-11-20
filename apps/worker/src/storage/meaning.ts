import { createJevClient, judgeFileRelevance, rankByRelevance } from "@omni/ai";
import type { ContextFile, ContextHit, StorageContext } from "@omni/db";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";

/** How many of the best word matches Jev judges. The rest keep their text order. */
export const DRIVE_RERANK_CANDIDATES = 30;
/** How many of the person's most recently changed files Jev also judges, whatever their words. */
export const DRIVE_MEANING_CANDIDATES = 200;
const JUDGE_BATCH = 100;
const MEANING_MATCH = 0.5;
const BUDGET_MS = 1_500;
const CACHE_TTL_MS = 120_000;
const CACHE_MAX_ENTRIES = 20_000;
const SNIPPET_CHARS = 240;

const judgments = new Map<string, { p: number; expires: number }>();

const cacheKey = (model: string, query: string, file: ContextFile) =>
  `${model}\n${query}\n${file.id}\n${file.contentVersion}`;

function remember(key: string, p: number, now: number) {
  judgments.delete(key);
  judgments.set(key, { p, expires: now + CACHE_TTL_MS });
  for (const oldest of judgments.keys()) {
    if (judgments.size <= CACHE_MAX_ENTRIES) break;
    judgments.delete(oldest);
  }
}

export type DriveHit = ContextHit & { match: "words" | "meaning" };

const withMatch = (hits: ContextHit[], meaning: Map<string, ContextFile>) =>
  hits.map((hit) => {
    const file = meaning.get(hit.node.id);
    if (!file) return { ...hit, match: "words" as const };
    const start = file.excerpt.replace(/\s+/g, " ").trim();
    return {
      ...hit,
      match: "meaning" as const,
      snippet: start.length > SNIPPET_CHARS ? `${start.slice(0, SNIPPET_CHARS)}…` : start,
    };
  }) satisfies DriveHit[];

async function judge(config: Config, query: string, pool: ContextFile[], log: Logger) {
  const client = createJevClient({
    apiKey: config.TYPESAFE_API_KEY!,
    model: config.JEV_MODEL,
    baseUrl: config.TYPESAFE_API_URL,
  });
  const now = Date.now();
  const relevance = new Map<string, number>();
  const unjudged: ContextFile[] = [];
  for (const file of pool) {
    const cached = judgments.get(cacheKey(client.model, query, file));
    if (cached && cached.expires > now) relevance.set(file.id, cached.p);
    else unjudged.push(file);
  }
  if (!unjudged.length) return relevance;
  try {
    const signal = AbortSignal.timeout(BUDGET_MS);
    const batches: ContextFile[][] = [];
    for (let i = 0; i < unjudged.length; i += JUDGE_BATCH) {
      batches.push(unjudged.slice(i, i + JUDGE_BATCH));
    }
    const judged = await Promise.all(
      batches.map((batch) =>
        judgeFileRelevance(client, query, batch, { now: new Date(now), signal }),
      ),
    );
    batches.forEach((batch, i) => {
      for (const file of batch) {
        const p = judged[i]!.relevance.get(file.id)!;
        relevance.set(file.id, p);
        remember(cacheKey(client.model, query, file), p, now);
      }
    });
    return relevance;
  } catch (error) {
    log.warn("drive.rerank_failed", {
      component: "storage",
      error: error instanceof Error ? error.message : String(error),
      candidates: unjudged.length,
      durationMs: Date.now() - now,
    });
    return null;
  }
}

/**
 * Drive search for an agent. Word matches come first in text order; with a TypeSafe key, Jev
 * also judges the person's most recently changed files, so a file is found by what it is about
 * even when it shares no word with the query (another language, other wording), and the best
 * matches are reordered by how well they fit. Only the chosen files are opened through the
 * person's doors. Without a key, or when Jev fails or is slow, it is word search alone.
 */
export const searchDrive: (
  drive: StorageContext,
  config: Config,
  query: string,
  options: { limit: number; workspace?: string; log: Logger },
) => Promise<{ hits: DriveHit[]; ranking: "jev" | "text" }> = async (
  drive,
  config,
  query,
  options,
) => {
  const scope = { workspace: options.workspace };
  const [words, recent] = await Promise.all([
    drive.wordMatches(query, {
      ...scope,
      limit: Math.max(options.limit * 3, DRIVE_RERANK_CANDIDATES),
    }),
    config.TYPESAFE_API_KEY
      ? drive.recentFiles({ ...scope, limit: DRIVE_MEANING_CANDIDATES })
      : Promise.resolve([] as ContextFile[]),
  ]);
  const byWords = async () => ({
    hits: withMatch(
      await drive.reveal(
        words.map((file) => file.id),
        query,
        options.limit,
      ),
      new Map(),
    ),
    ranking: "text" as const,
  });
  const matched = new Set(words.map((file) => file.id));
  const unmatched = recent.filter((file) => !matched.has(file.id));
  const pool = [...words.slice(0, DRIVE_RERANK_CANDIDATES), ...unmatched];
  if (!config.TYPESAFE_API_KEY || (pool.length < 2 && !unmatched.length)) return byWords();

  const relevance = await judge(config, query, pool, options.log);
  if (!relevance) return byWords();
  const byMeaning = unmatched.filter((file) => (relevance.get(file.id) ?? 0) >= MEANING_MATCH);
  const ranked = rankByRelevance([...words, ...byMeaning], relevance);
  const hits = await drive.reveal(
    ranked.map((file) => file.id),
    query,
    options.limit,
  );
  return {
    hits: withMatch(hits, new Map(byMeaning.map((file) => [file.id, file]))),
    ranking: "jev",
  };
};
