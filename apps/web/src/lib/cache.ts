// Optimistic cache edits for thread actions. Every edit goes through a snapshot so a failed
// request puts the cache back exactly as it was.
import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { filterOf, keys } from "./query-keys.ts";
import type { Thread, ThreadFilter, ThreadPage, ThreadSummary } from "./types.ts";

type ThreadPages = InfiniteData<ThreadPage, string | null>;
export type Snapshot = [QueryKey, unknown][];

/**
 * Cancels in-flight thread fetches (so they cannot overwrite the edit) and records the lists
 * and the thread as they are now.
 */
export async function snapshotThread(client: QueryClient, threadId: string): Promise<Snapshot> {
  await Promise.all([
    client.cancelQueries({ queryKey: keys.threadLists() }),
    client.cancelQueries({ queryKey: keys.thread(threadId) }),
  ]);
  return [
    ...client.getQueriesData({ queryKey: keys.threadLists() }),
    [keys.thread(threadId), client.getQueryData(keys.thread(threadId))],
  ];
}

export function restore(client: QueryClient, snapshot: Snapshot | undefined) {
  for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

/** Applies a patch to the thread in every cached list and in its detail. */
export function patchThread(
  client: QueryClient,
  threadId: string,
  patch: Partial<ThreadSummary> & Partial<Thread>,
) {
  client.setQueriesData<ThreadPages>({ queryKey: keys.threadLists() }, (data) =>
    mapRows(data, (row) => (row.id === threadId ? { ...row, ...patch } : row)),
  );
  client.setQueryData<Thread>(keys.thread(threadId), (thread) =>
    thread ? { ...thread, ...patch } : thread,
  );
}

/** Removes the thread from every cached list whose filter matches `where`. */
export function removeFromLists(
  client: QueryClient,
  threadId: string,
  where: (filter: ThreadFilter) => boolean,
) {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.threadLists() })) {
    const filter = filterOf(query.queryKey);
    if (!filter || !where(filter)) continue;
    client.setQueryData<ThreadPages>(query.queryKey, (data) =>
      mapPages(data, (page) => ({
        ...page,
        threads: page.threads.filter((row) => row.id !== threadId),
      })),
    );
  }
}

/** Refetches what an action may have changed: lists, counts, and the thread itself. */
export function invalidateThread(client: QueryClient, threadId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: keys.threadLists() }),
    client.invalidateQueries({ queryKey: keys.counts() }),
    client.invalidateQueries({ queryKey: keys.thread(threadId) }),
  ]);
}

function mapPages(data: ThreadPages | undefined, fn: (page: ThreadPage) => ThreadPage) {
  return data ? { ...data, pages: data.pages.map(fn) } : data;
}

function mapRows(data: ThreadPages | undefined, fn: (row: ThreadSummary) => ThreadSummary) {
  return mapPages(data, (page) => ({ ...page, threads: page.threads.map(fn) }));
}
