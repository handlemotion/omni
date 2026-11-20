import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { crmCompaniesQuery, crmDealsQuery, crmFindQuery, crmPeopleQuery } from "../lib/crm.ts";
import type { CrmCompany, CrmDeal, CrmPerson } from "../lib/crm.ts";
import { crmTasksQuery, type CrmTask } from "../lib/crm-tasks.ts";
import { threadsQuery } from "../lib/mail-queries.ts";
import { keys } from "../lib/query-keys.ts";
import { storageListQuery, type StorageNode } from "../lib/storage.ts";
import { storageSearchQuery } from "../lib/storage-find.ts";
import { senderLabel } from "../lib/threads.ts";
import type { ThreadSummary } from "../lib/types.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";

const LIMIT = 8;
const SERVER_DELAY_MS = 120;

/** A file or folder; one shared with the member from elsewhere carries the link that opens it. */
export type FileHit = StorageNode & { shareId?: string };

type SharedItem = { node: StorageNode; shareId: string | null };

export interface CommandHits {
  files: FileHit[];
  companies: CrmCompany[];
  people: CrmPerson[];
  deals: CrmDeal[];
  /** Open tasks, by title. */
  tasks: CrmTask[];
  threads: ThreadSummary[];
  /** True while a server search for the current text is still on its way. */
  searching: boolean;
}

function cached<T>(client: QueryClient, prefix: readonly unknown[], field: string) {
  const out: T[] = [];
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
    void client.prefetchInfiniteQuery(crmTasksQuery({ status: "open" }));
  }, [client, company]);
}

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

function taskHits(
  client: QueryClient,
  needle: string,
  found: CrmTask[] | undefined,
  fresh: boolean,
) {
  const open = cached<CrmTask>(client, [...keys.crm(), "tasks", "list"], "tasks").filter(
    (task) => !task.completedAt,
  );
  return pick(open, fresh ? found : undefined, needle, (task) => task.title);
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
  const tasks = useInfiniteQuery({
    ...crmTasksQuery({ status: "open", q: settled }),
    enabled: company && settled.length > 0,
    placeholderData: (prev) => prev,
  });

  return useMemo(() => {
    void version;
    if (!needle) {
      return {
        files: [],
        companies: [],
        people: [],
        deals: [],
        tasks: [],
        threads: [],
        searching: false,
      };
    }
    const fresh = settled === needle;
    const drive = split(files, fresh);
    return {
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
      tasks: company ? taskHits(client, needle, tasks.data?.pages[0]?.tasks, fresh) : [],
      threads: pick(
        cached<ThreadSummary>(client, keys.threadLists(), "threads"),
        undefined,
        needle,
        threadText,
      ),
      searching: !fresh || files.isFetching || crm.isFetching || tasks.isFetching,
    };
  }, [version, client, needle, settled, company, files, crm, tasks]) satisfies CommandHits;
}
