import { judgeFileRelevance, rankByRelevance } from "@omni/ai";
import type { ContextFile, ContextHit, StorageContext } from "@omni/db";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";
import { cachedJudge, MEANING_MATCH } from "../rerank.ts";

/** How many of the best word matches Jev judges. The rest keep their text order. */
export const DRIVE_RERANK_CANDIDATES = 30;
/** How many of the person's most recently changed files Jev also judges, whatever their words. */
export const DRIVE_MEANING_CANDIDATES = 200;
const SNIPPET_CHARS = 240;

const judge = cachedJudge<ContextFile>({
  judge: judgeFileRelevance,
  idOf: (file) => file.id,
  keyOf: (file) => `${file.id}\n${file.contentVersion}`,
  event: "drive.rerank_failed",
  component: "storage",
});

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
