import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { filterOf, keys } from "./query-keys.ts";
import type {
  ConversationPage,
  Thread,
  ThreadFilter,
  ThreadPage,
  ThreadSummary,
  ThreadView,
} from "./types.ts";

type ThreadPages = InfiniteData<ThreadPage, string | null>;
type ConversationPages = InfiniteData<ConversationPage, string | null>;
export type Snapshot = [QueryKey, unknown][];

/**
 * Cancels in-flight thread fetches (so they cannot overwrite the edit) and records the lists
 * (mail and helpdesk) and the thread as they are now.
 */
export async function snapshotThread(client: QueryClient, threadId: string) {
  await Promise.all([
    client.cancelQueries({ queryKey: keys.threadLists() }),
    client.cancelQueries({ queryKey: keys.conversationLists() }),
    client.cancelQueries({ queryKey: keys.thread(threadId) }),
  ]);
  return [
    ...client.getQueriesData({ queryKey: keys.threadLists() }),
    ...client.getQueriesData({ queryKey: keys.conversationLists() }),
    [keys.thread(threadId), client.getQueryData(keys.thread(threadId))],
  ] satisfies Snapshot;
}

export function restore(client: QueryClient, snapshot: Snapshot | undefined) {
  for (const [key, data] of snapshot ?? []) client.setQueryData(key, data);
}

type ThreadPatch = Partial<ThreadSummary> & Partial<Thread>;

/**
 * What a triage action does to the cache before the server answers: patches the thread, and
 * takes it out of every list whose view it `leaves`. A mutation declares it as
 * `meta.optimistic`, so fetches that land while it is pending show it too.
 */
export interface ThreadEffect {
  threadId: string;
  patch: ThreadPatch;
  leaves?: (view: ThreadView | undefined) => boolean;
}

/** Applies `effect` to every cached list and to the thread. */
export function applyEffect(client: QueryClient, { threadId, patch, leaves }: ThreadEffect) {
  patchThread(client, threadId, patch);
  if (leaves) removeFromLists(client, threadId, (filter) => leaves(filter.view));
}

/**
 * The effects of the mail actions not yet settled, oldest first, except the one run with
 * `excluding` (its variables). A list fetched while one is pending predates it on the server.
 */
export function pendingEffects(client: QueryClient, excluding?: unknown) {
  return client
    .getMutationCache()
    .findAll({ mutationKey: keys.mail(), status: "pending" })
    .flatMap((mutation) => {
      const effect = mutation.meta?.optimistic;
      const { variables } = mutation.state;
      return effect && variables !== excluding ? [effect(variables as never)] : [];
    });
}

/** A fetched list page, as it looks once the pending actions have landed. */
export function withPendingEffects(client: QueryClient, filter: ThreadFilter, page: ThreadPage) {
  return pendingEffects(client).reduce(
    (current, { threadId, patch, leaves }) => ({
      ...current,
      threads: current.threads.flatMap((row) => {
        if (row.id !== threadId) return [row];
        return leaves?.(filter.view) ? [] : [{ ...row, ...patch }];
      }),
    }),
    page,
  );
}

/** A fetched thread, as it looks once the pending actions on it have landed. */
export function threadWithPendingEffects(client: QueryClient, thread: Thread) {
  return pendingEffects(client)
    .filter((effect) => effect.threadId === thread.id)
    .reduce((current, { patch }) => ({ ...current, ...patch }), thread);
}

/**
 * Undoes a failed action: puts back the cache as it was before it, then re-applies the actions
 * still pending since, so their threads don't come back with it. Lists first fetched while it
 * was pending are not in the snapshot, so the thread and every list refetch too.
 */
export function restoreFailed(
  client: QueryClient,
  snapshot: Snapshot | undefined,
  variables: { threadId: string },
) {
  restore(client, snapshot);
  for (const effect of pendingEffects(client, variables)) applyEffect(client, effect);
  void invalidateThread(client, variables.threadId);
}

/**
 * Applies a patch to the thread in every cached list and in its detail. A helpdesk row takes
 * only the fields it has (read state, say), not mail-only ones like `done`.
 */
export function patchThread(client: QueryClient, threadId: string, patch: ThreadPatch) {
  client.setQueriesData<ThreadPages>({ queryKey: keys.threadLists() }, (data) =>
    mapRows(data, (row) => (row.id === threadId ? { ...row, ...patch } : row)),
  );
  client.setQueriesData<ConversationPages>({ queryKey: keys.conversationLists() }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            conversations: page.conversations.map((row) =>
              row.id === threadId ? { ...row, ...shared(row, patch) } : row,
            ),
          })),
        }
      : data,
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

function shared<T extends object>(row: T, patch: object) {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in row),
  ) as Partial<T> satisfies Partial<T>;
}

function mapPages(data: ThreadPages | undefined, fn: (page: ThreadPage) => ThreadPage) {
  return data ? { ...data, pages: data.pages.map(fn) } : data;
}

function mapRows(data: ThreadPages | undefined, fn: (row: ThreadSummary) => ThreadSummary) {
  return mapPages(data, (page) => ({ ...page, threads: page.threads.map(fn) }));
}
