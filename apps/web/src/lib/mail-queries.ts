import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { prunePending } from "./pending.ts";
import { keys } from "./query-keys.ts";
import type { ThreadFilter } from "./types.ts";

/**
 * A list's first page is what the screen opens with: small, so it comes back quickly. Older
 * pages are as large as the API allows, so scrolling deep takes half the round trips.
 */
export const FIRST_PAGE_SIZE = 50;
export const OLDER_PAGE_SIZE = 100;

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: keys.mailboxes(),
    queryFn: ({ signal }) => call(api.mailboxes.$get(undefined, { init: { signal } })),
    select: (data) => data.mailboxes,
    staleTime: 5 * 60_000,
  });

/**
 * Every mailbox the user can open, in every workspace their session reaches, each with its
 * `orgId`: what compose sends from, and how a thread from another workspace finds
 * its mailbox. `mailboxesQuery` stays the active workspace's, for its settings.
 */
export const allMailboxesQuery = () =>
  queryOptions({
    queryKey: keys.allMailboxes(),
    queryFn: ({ signal }) =>
      call(api.mailboxes.$get({ query: { scope: "all" } }, { init: { signal } })),
    select: (data) => data.mailboxes,
    staleTime: 5 * 60_000,
  });

/**
 * Unread threads per mailbox and lane (inbox view), for badges, in the active workspace.
 */
export const countsQuery = () =>
  queryOptions({
    queryKey: keys.counts(),
    queryFn: ({ signal }) => call(api.counts.$get({ query: {} }, { init: { signal } })),
  });

/**
 * One thread list, newest first, paged by an opaque cursor kept in the cache (not the URL).
 * Without a mailbox it is "All mailboxes": every mailbox of the active workspace the member can
 * open, never another workspace's (amended: workspace isolation).
 */
export const threadsQuery = (filter: ThreadFilter) =>
  infiniteQueryOptions({
    queryKey: keys.threads(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.threads.$get(
          {
            query: {
              view: filter.view,
              ...(filter.mailbox ? { mailboxId: filter.mailbox } : {}),
              ...(filter.lane ? { lane: filter.lane } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(pageParam ? OLDER_PAGE_SIZE : FIRST_PAGE_SIZE),
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

const SEARCH_LIMIT = 50;

/** Search the active workspace's mail (amended: workspace isolation). */
export const searchQuery = (q: string, mailbox?: string) =>
  queryOptions({
    queryKey: keys.search(q, mailbox),
    queryFn: ({ signal }) =>
      call(
        api.search.$get(
          {
            query: {
              q,
              limit: String(SEARCH_LIMIT),
              ...(mailbox ? { mailboxId: mailbox } : {}),
            },
          },
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
