// Reading mail. Each hook subscribes to one query from `lib/mail-queries.ts`; route loaders
// prefetch the same queries, so a hook on a freshly loaded route renders from cache.
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
  keepPreviousData,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  countsQuery,
  mailboxesQuery,
  searchQuery,
  threadQuery,
  threadsQuery,
} from "../lib/mail-queries.ts";
import type { PendingSend } from "../lib/pending.ts";
import { keys } from "../lib/query-keys.ts";
import type { ThreadFilter } from "../lib/types.ts";

/** Mailboxes the member can see. */
export function useMailboxes() {
  return useQuery(mailboxesQuery());
}

/** Unread counts per mailbox and lane, for badges. Refetches whenever mail changes. */
export function useCounts() {
  return useQuery(countsQuery());
}

/**
 * One thread list (inbox, queue, done, archive or all; optionally one mailbox and lane), newest first.
 * `threads` is every loaded page flattened; call `fetchNextPage` near the end of the list.
 */
export function useThreads(filter: ThreadFilter) {
  const query = useInfiniteQuery(threadsQuery(filter));
  const threads = useMemo(
    () => query.data?.pages.flatMap((page) => page.threads) ?? [],
    [query.data],
  );
  return { ...query, threads };
}

/**
 * A thread with its messages, plus `pending`: replies sent from this app that have not come
 * back as messages yet (newest last). Render them after `thread.messages`.
 */
export function useThread(threadId: string) {
  const query = useQuery(threadQuery(threadId));
  const pending = usePendingSends(threadId);
  return { ...query, thread: query.data, pending };
}

/** Like `useThread`, but suspends until loaded: for route components whose loader fetched it. */
export function useSuspenseThread(threadId: string) {
  const query = useSuspenseQuery(threadQuery(threadId));
  const pending = usePendingSends(threadId);
  return { ...query, thread: query.data, pending };
}

/** Replies waiting to arrive, with their status (`sending`, `queued`, `failed`). */
export function usePendingSends(threadId: string) {
  return (
    useQuery({
      queryKey: keys.pending(threadId),
      queryFn: () => [] as PendingSend[],
      initialData: [] as PendingSend[],
    }).data ?? []
  );
}

/** Mail search: one row per thread, best match first. Disabled for an empty query. */
export function useSearch(q: string, mailbox?: string) {
  // Keep the previous results on screen while the next query loads, so lists don't flash empty.
  return useQuery({ ...searchQuery(q, mailbox), placeholderData: keepPreviousData });
}

/**
 * Returns a function that warms a thread's cache: call it on hover or focus of a list row so
 * opening the thread renders instantly.
 */
export function usePrefetchThread() {
  const client = useQueryClient();
  return useCallback(
    (threadId: string) => void client.prefetchQuery(threadQuery(threadId)),
    [client],
  );
}
