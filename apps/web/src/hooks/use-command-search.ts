// What the ⌘K menu finds by name: Drive's files and folders, the CRM's companies, people and
// deals, and mail. Two sources, so the first results never wait on the network:
//
// - local: everything already in the query cache (every folder listing, CRM list and mail list
//   the member opened, plus what the menu warms when it opens), matched as each key is typed;
// - server: Drive's and the CRM's name searches, asked once typing pauses for a beat, their hits
//   merged in under the local ones as they arrive (the last answer stays up while the next loads).
//
// Mail has no per-keystroke server search: its search judges relevance with a model and is rate
// limited, so it stays the menu's "Smart search" row.
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { crmCompaniesQuery, crmDealsQuery, crmFindQuery, crmPeopleQuery } from "../lib/crm.ts";
import type { CrmCompany, CrmDeal, CrmPerson } from "../lib/crm.ts";
import { threadsQuery } from "../lib/mail-queries.ts";
import { keys } from "../lib/query-keys.ts";
import { storageListQuery, type StorageNode } from "../lib/storage.ts";
import { storageSearchQuery } from "../lib/storage-find.ts";
import { senderLabel } from "../lib/threads.ts";
import type { ThreadSummary } from "../lib/types.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";

/** Most hits of one kind the menu lists; the rest are a narrower query away. */
const LIMIT = 8;
/** How long typing pauses before the server is asked: short, as the local hits already show. */
const SERVER_DELAY_MS = 120;

/** A file or folder; one shared with the member from elsewhere carries the link that opens it. */
export type FileHit = StorageNode & { shareId?: string };

/** What Shared with me lists: the node, and its `/s/<shareId>` link (none: it can't be opened). */
type SharedItem = { node: StorageNode; shareId: string | null };

export interface CommandHits {
  files: FileHit[];
  companies: CrmCompany[];
  people: CrmPerson[];
  deals: CrmDeal[];
  threads: ThreadSummary[];
  /** True while a server search for the current text is still on its way. */
  searching: boolean;
}

/** Every array named `field` in the cached answers under `prefix`, infinite lists included. */
function cached<T>(client: QueryClient, prefix: readonly unknown[], field: string) {
  const out: T[] = [];
  // An invalidated answer may hold what has since gone (a folder's files after it went to Trash)
  // until it is fetched again; the server's search covers what it leaves out meanwhile.
  for (const query of client.getQueryCache().findAll({ queryKey: prefix })) {
    if (query.state.isInvalidated) continue;
    const data: unknown = query.state.data;
    const pages =
      data && typeof data === "object" && "pages" in data && Array.isArray(data.pages)
        ? data.pages
        : [data];
    for (const page of pages) {
      const list =
        page && typeof page === "object" ? (page as Record<string, unknown>)[field] : null;
      if (Array.isArray(list)) out.push(...(list as T[]));
    }
  }
  return out satisfies T[];
}

/**
 * The first `LIMIT` of the cached `items` whose text holds `needle`, then the server's `found`,
 * one per id, in order. The server's are kept as it matched them (the CRM matches each word on
 * its own, so "an sm" finds Ann Smith), not filtered again.
 */
function pick<T extends { id: string }>(
  items: Iterable<T>,
  found: readonly T[] | undefined,
  needle: string,
  text: (item: T) => string,
) {
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (item: T) => {
    if (out.length >= LIMIT || seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  for (const item of items) if (text(item).toLowerCase().includes(needle)) add(item);
  for (const item of found ?? []) add(item);
  return out satisfies T[];
}

/** A number that changes whenever a query in the cache gets new data or goes stale, so hits read it again. */
function useCacheVersion(client: QueryClient) {
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          (event.action.type === "success" || event.action.type === "invalidate")
        )
          setVersion((v) => v + 1);
      }),
    [client],
  );
  return version;
}

const personText = (p: CrmPerson) => [p.name, ...p.addresses.map((a) => a.address)].join(" ");
const threadText = (t: ThreadSummary) => `${t.subject} ${senderLabel(t)}`;

/**
 * Fills the cache the local search reads, once per menu opening: Drive's roots, the CRM's first
 * pages and the inbox, so a module never opened this session still answers at once. Each is a
 * no-op while its data is fresh.
 */
export function useWarmCommandSearch(company: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    void client.prefetchInfiniteQuery(storageListQuery({ space: "personal" }));
    void client.prefetchInfiniteQuery(threadsQuery({ view: "inbox" }));
    if (!company) return;
    void client.prefetchInfiniteQuery(storageListQuery({ space: "shared" }));
    void client.prefetchInfiniteQuery(crmCompaniesQuery(""));
    void client.prefetchInfiniteQuery(crmPeopleQuery(""));
    void client.prefetchInfiniteQuery(crmDealsQuery(""));
  }, [client, company]);
}

/**
 * A server answer, split: the one for this very text is kept as the server matched it; an older
 * one (still on screen while the next loads) counts only where its names hold the text.
 */
function split<T>(query: { data?: T | undefined; isPlaceholderData: boolean }, fresh: boolean) {
  return fresh && !query.isPlaceholderData
    ? { found: query.data, stale: undefined }
    : { found: undefined, stale: query.data };
}

type CrmFound = { companies: CrmCompany[]; people: CrmPerson[]; deals: CrmDeal[] };

function crmHits(
  client: QueryClient,
  needle: string,
  answer: { found?: CrmFound | undefined; stale?: CrmFound | undefined },
) {
  const crmKey = keys.crm();
  const { found, stale } = answer;
  return {
    companies: pick(
      [
        ...cached<CrmCompany>(client, [...crmKey, "companies"], "companies"),
        ...(stale?.companies ?? []),
      ],
      found?.companies,
      needle,
      (c) => c.name,
    ),
    people: pick(
      [...cached<CrmPerson>(client, [...crmKey, "people"], "people"), ...(stale?.people ?? [])],
      found?.people,
      needle,
      personText,
    ),
    deals: pick(
      [...cached<CrmDeal>(client, keys.crmDealLists(), "deals"), ...(stale?.deals ?? [])],
      found?.deals,
      needle,
      (d) => d.name,
    ),
  };
}

/** Records named like `text`: local ones at once, the server's merged in as they arrive. */
export function useCommandSearch(text: string, company: boolean) {
  const client = useQueryClient();
  const version = useCacheVersion(client);
  const needle = text.trim().toLowerCase();
  const settled = useDebouncedValue(needle, SERVER_DELAY_MS);
  const files = useQuery({ ...storageSearchQuery(settled), placeholderData: (prev) => prev });
  const crm = useQuery({
    ...crmFindQuery(settled),
    enabled: company && settled.length > 0,
    placeholderData: (prev) => prev,
  });

  return useMemo(() => {
    void version; // read again whenever the cache gets new data
    if (!needle) {
      return { files: [], companies: [], people: [], deals: [], threads: [], searching: false };
    }
    const fresh = settled === needle;
    const drive = split(files, fresh);
    return {
      // The server's own answers come after the cache's, so what showed first stays put.
      files: pick(
        [
          ...cached<StorageNode>(client, [...keys.storage(), "list"], "nodes"),
          ...cached<SharedItem>(client, keys.storageSharedWithMe(), "items").flatMap((item) =>
            item.shareId ? [{ ...item.node, shareId: item.shareId }] : [],
          ),
          ...(drive.stale?.nodes ?? []),
        ],
        drive.found?.nodes,
        needle,
        (n) => n.name,
      ),
      ...(company
        ? crmHits(client, needle, split(crm, fresh))
        : { companies: [], people: [], deals: [] }),
      threads: pick(
        cached<ThreadSummary>(client, keys.threadLists(), "threads"),
        undefined,
        needle,
        threadText,
      ),
      searching: !fresh || files.isFetching || crm.isFetching,
    };
  }, [version, client, needle, settled, company, files, crm]) satisfies CommandHits;
}
