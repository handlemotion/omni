// Read queries for mail, as `queryOptions` so loaders (prefetch) and hooks (subscribe) share one
// definition. Each passes the query's abort signal, so a cancelled query cancels its request.
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { prunePending } from "./pending.ts";
import { keys } from "./query-keys.ts";
import type { ThreadFilter } from "./types.ts";

const THREAD_PAGE_SIZE = 50;

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: keys.mailboxes(),
    queryFn: ({ signal }) => call(api.mailboxes.$get(undefined, { init: { signal } })),
    select: (data) => data.mailboxes,
    // Mailboxes change only when someone runs `mailbox:add`.
    staleTime: 5 * 60_000,
  });

/**
 * Unread threads per mailbox and lane (inbox view), for badges, in every workspace the user
 * belongs to (each row carries its `orgId`).
 */
export const countsQuery = () =>
  queryOptions({
    queryKey: keys.counts(),
    queryFn: ({ signal }) =>
      call(api.counts.$get({ query: { scope: "all" } }, { init: { signal } })),
  });

/**
 * One thread list, newest first, paged by an opaque cursor kept in the cache (not the URL).
 * Without a mailbox it spans every workspace the user belongs to ("All mailboxes", ADR 0014);
 * each row carries its `orgId`, and opening or acting on it needs no workspace switch.
 */
export const threadsQuery = (filter: ThreadFilter) =>
  infiniteQueryOptions({
    queryKey: keys.threads(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.threads.$get(
          {
            query: {
              scope: "all",
              view: filter.view,
              ...(filter.mailbox ? { mailboxId: filter.mailbox } : {}),
              ...(filter.lane ? { lane: filter.lane } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(THREAD_PAGE_SIZE),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/**
 * A thread with every message. Fetching it also drops pending sends that have now arrived as
 * real messages (matched by Message-ID), so a sent reply never shows twice.
 */
export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.thread(threadId),
    queryFn: async ({ signal, client }) => {
      const thread = await call(
        api.threads[":id"].$get({ param: { id: threadId } }, { init: { signal } }),
      );
      prunePending(client, threadId, thread.messages);
      return thread;
    },
  });

export const searchQuery = (q: string, mailbox?: string) =>
  queryOptions({
    queryKey: keys.search(q, mailbox),
    queryFn: ({ signal }) =>
      call(
        api.search.$get(
          { query: { q, ...(mailbox ? { mailboxId: mailbox } : {}) } },
          { init: { signal } },
        ),
      ),
    select: (data) => data.results,
    enabled: q.trim().length > 0,
  });

/** Status of one outbox action (send, archive, …): for checking pending sends after a reconnect. */
export const actionQuery = (actionId: string) =>
  queryOptions({
    queryKey: keys.action(actionId),
    queryFn: ({ signal }) =>
      call(api.actions[":id"].$get({ param: { id: actionId } }, { init: { signal } })),
  });
