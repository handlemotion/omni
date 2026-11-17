import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { Mailbox, ThreadPage } from "@omni/client";
import { ApiError, api, call, isAuthError } from "./api.ts";
import { keys } from "./query-keys.ts";

const FIRST_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 100;

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: keys.mailboxes(),
    queryFn: ({ signal }) =>
      call(api.mailboxes.$get({ query: { scope: "all" } }, { init: { signal } })),
    select: (data) => data.mailboxes,
    staleTime: 5 * 60_000,
  });

/** Unread inbox threads per mailbox, for the switcher's badges. */
export const countsQuery = () =>
  queryOptions({
    queryKey: keys.counts(),
    queryFn: ({ signal }) =>
      call(api.counts.$get({ query: { scope: "all" } }, { init: { signal } })),
    select: (data) => data.counts,
  });

/** The inbox, newest first; without a mailbox, every inbox the person can open. */
export const inboxQuery = (mailboxId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: keys.threads(mailboxId),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.threads.$get(
          {
            query: {
              scope: "all",
              view: "inbox",
              ...(mailboxId ? { mailboxId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(pageParam ? OLDER_PAGE_SIZE : FIRST_PAGE_SIZE),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.threads),
  });

export const useMailboxes = () => useQuery(mailboxesQuery());
export const useCounts = () => useQuery(countsQuery());
export const useInbox = (mailboxId: string | undefined) => useInfiniteQuery(inboxQuery(mailboxId));

/** What a mailbox is called, as on the web: you, for your own; its local part for a shared one. */
export function mailboxName(mailbox: Pick<Mailbox, "kind" | "address">, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A list row's time: the clock today, the date before. */
export function listTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString() ? TIME.format(date) : DAY.format(date);
}

/** A thread with every message, each with only what its sender newly wrote. */
export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.thread(threadId),
    queryFn: ({ signal }) =>
      call(api.threads[":id"].$get({ param: { id: threadId } }, { init: { signal } })),
  });

export const useThread = (threadId: string) => useQuery(threadQuery(threadId));

/** One message's sanitized HTML, as the Worker serves it for a sandboxed view. */
export const useMessageHtml = (threadId: string, messageId: string) =>
  useQuery({
    queryKey: [...keys.thread(threadId), "html", messageId],
    queryFn: async ({ signal }) => {
      const response = await api.threads[":id"].messages[":messageId"].html.$get(
        { param: { id: threadId, messageId } },
        { init: { signal } },
      );
      if (!response.ok) throw new ApiError(response.status, "the message didn't load");
      return response.text();
    },
    staleTime: Infinity,
  });

/**
 * Marks a thread read, as opening it does on the web: the list row and the counts follow at once,
 * and a retry reuses the same idempotency key.
 */
export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, key }: { threadId: string; key: string }) =>
      call(
        api.threads[":id"].state.$patch({
          param: { id: threadId },
          header: { "idempotency-key": key },
          json: { read: true },
        }),
      ),
    retry: (count, error) => !isAuthError(error) && count < 2,
    onMutate: async ({ threadId }) => {
      await client.cancelQueries({ queryKey: ["threads"] });
      const snapshot = client.getQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] });
      client.setQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                threads: page.threads.map((t) =>
                  t.id === threadId ? { ...t, read: true, unread: false } : t,
                ),
              })),
            }
          : data,
      );
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) client.setQueryData(key, data);
      void client.invalidateQueries({ queryKey: ["threads"] });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: keys.counts() }),
  });
}
