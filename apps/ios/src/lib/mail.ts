import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { Mailbox, SearchResult, Thread, ThreadPage } from "@omni/client";
import { useCallback, useMemo } from "react";
import type { SymbolName } from "./symbols.ts";
import { ApiError, api, call, inWorkspace, isAuthError } from "./api.ts";
import { WARM_NEWEST, opensFull } from "./message-html.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

const FIRST_PAGE_SIZE = 30;
const OLDER_PAGE_SIZE = 100;

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: keys.mailboxes(),
    queryFn: ({ signal }) => call(api.mailboxes.$get({ query: {} }, { init: { signal } })),
    select: (data) => data.mailboxes,
    staleTime: 5 * 60_000,
  });

/** Unread inbox threads per mailbox, for the switcher's badges. */
export const countsQuery = () =>
  queryOptions({
    queryKey: keys.counts(),
    queryFn: ({ signal }) => call(api.counts.$get({ query: {} }, { init: { signal } })),
    select: (data) => data.counts,
  });

interface MailPageInfo {
  label: string;
  view: string;
  lane?: string;
  /** Its SF Symbol in the page menu. */
  icon: SymbolName;
  /** The list's title when it has nothing, as the web's empty state says it. */
  empty: string;
}

/** Mail's pages, as the web sidebar lists them: a view of the threads, and for two, a lane. */
export const MAIL_PAGES = {
  inbox: { label: "Inbox", view: "inbox", icon: "tray", empty: "Inbox zero" },
  later: { label: "Later", view: "later", icon: "clock", empty: "Nothing for later" },
  needsReply: {
    label: "Needs reply",
    view: "inbox",
    lane: "needs_reply",
    icon: "bubble",
    empty: "Nothing needs a reply",
  },
  awaitingReply: {
    label: "Awaiting reply",
    view: "inbox",
    lane: "waiting_on_them",
    icon: "ellipsis.bubble",
    empty: "Not waiting on anyone",
  },
  done: { label: "Done", view: "done", icon: "checkmark.circle", empty: "Nothing done yet" },
  archive: { label: "Archive", view: "archive", icon: "archivebox", empty: "Nothing archived" },
  all: { label: "All mail", view: "all", icon: "envelope", empty: "No mail yet" },
  sent: { label: "Sent", view: "sent", icon: "paperplane", empty: "Nothing sent yet" },
  trash: { label: "Trash", view: "trash", icon: "trash", empty: "Trash is empty" },
  spam: { label: "Spam", view: "spam", icon: "exclamationmark.triangle", empty: "No spam" },
} as const satisfies Record<string, MailPageInfo>;

export type MailPage = keyof typeof MAIL_PAGES;

export const isMailPage = (page: string | undefined): page is MailPage =>
  !!page && Object.hasOwn(MAIL_PAGES, page);

/** A page's threads, newest first; without a mailbox, every one the person can open here. */
export const threadsQuery = (page: MailPage, mailboxId: string | undefined) =>
  infiniteQueryOptions({
    queryKey: keys.threads(page, mailboxId),
    queryFn: ({ pageParam, signal }) => {
      const { view, ...rest } = MAIL_PAGES[page];
      const lane = "lane" in rest ? rest.lane : undefined;
      return call(
        api.threads.$get(
          {
            query: {
              view,
              ...(lane ? { lane } : {}),
              ...(mailboxId ? { mailboxId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: String(pageParam ? OLDER_PAGE_SIZE : FIRST_PAGE_SIZE),
            },
          },
          { init: { signal } },
        ),
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages.flatMap((one) => one.threads),
  });

export const useMailboxes = () => useQuery(mailboxesQuery());
export const useCounts = () => useQuery(countsQuery());
export const useThreads = (page: MailPage, mailboxId: string | undefined) =>
  useInfiniteQuery(threadsQuery(page, mailboxId));

/** What a mailbox is called, as on the web: you, for your own; its local part for a shared one. */
export function mailboxName(mailbox: Pick<Mailbox, "kind" | "address">, you: string) {
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export { bySection, listTime, type Sectioned } from "@omni/mail-core/list-dates";

/** Mail search across the workspace, best match first. */
export const useSearch = (q: string) =>
  useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) =>
      call(api.search.$get({ query: { q, limit: "50" } }, { init: { signal } })),
    select: (data) => data.results,
    enabled: q.trim().length > 0,
    placeholderData: (previous) => previous,
  });

/** A thread with every message, each with only what its sender newly wrote. */
export const threadQuery = (threadId: string) =>
  queryOptions({
    queryKey: keys.thread(threadId),
    queryFn: ({ signal }) =>
      call(api.threads[":id"].$get({ param: { id: threadId } }, { init: { signal } })),
  });

export const useThread = (threadId: string) => useQuery(threadQuery(threadId));

/** One message's sanitized HTML, as the Worker serves it for a sandboxed view. */
export const messageHtmlQuery = (threadId: string, messageId: string) =>
  queryOptions({
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

export const useMessageHtml = (threadId: string, messageId: string) =>
  useQuery(messageHtmlQuery(threadId, messageId));

const PREFETCH_FRESH = 30_000;

/**
 * Warms a thread before it opens, as the web does on hover: its messages, then the HTML of its
 * newest messages that open full, so the conversation renders whole instead of waiting on a
 * second round trip once it arrives. Called as a row is pressed.
 */
export function usePrefetchThread() {
  const client = useQueryClient();
  return useCallback(
    (threadId: string) =>
      void client.fetchQuery({ ...threadQuery(threadId), staleTime: PREFETCH_FRESH }).then(
        (thread) => {
          for (const message of thread.messages.slice(-WARM_NEWEST)) {
            if (opensFull(message))
              void client.prefetchQuery(messageHtmlQuery(threadId, message.id));
          }
          return undefined;
        },
        () => undefined,
      ),
    [client],
  );
}

/** One queue for every thread action, opening's mark-read included, so they land in order. */
export const MAIL_ACTIONS_SCOPE = { id: "mail-actions" };

/** Every thread action's `mutationKey`, so a settling one can tell whether others are still queued. */
export const MAIL_ACTIONS_KEY = ["mail-actions"] as const;

/**
 * After a thread action: the counts refetch, and the lists and every thread's detail (not its
 * message HTML) refetch once the last queued action settles, so an earlier refetch never
 * overwrites a later optimistic edit and no acted-on thread is left stale.
 */
export function settleMailAction(client: QueryClient) {
  void client.invalidateQueries({ queryKey: keys.counts() });
  if (client.isMutating({ mutationKey: MAIL_ACTIONS_KEY }) > 1) return;
  void client.invalidateQueries({ queryKey: ["threads"] });
  void client.invalidateQueries({ queryKey: ["search"] });
  void client.invalidateQueries({
    queryKey: ["thread"],
    predicate: (query) => query.queryKey.length === 2,
  });
}

interface MarkRead {
  threadId: string;
  key: string;
}

/**
 * Marks a thread read, as opening it does on the web: the list row and the counts follow at once,
 * and a retry reuses the same idempotency key.
 */
export function useMarkRead() {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ threadId, key, workspace }: MarkRead & { workspace: string | null }) =>
      call(
        api.threads[":id"].state.$patch(
          { param: { id: threadId }, header: { "idempotency-key": key }, json: { read: true } },
          inWorkspace(workspace),
        ),
      ),
    retry: (count, error) => !isAuthError(error) && count < 2,
    mutationKey: MAIL_ACTIONS_KEY,
    scope: MAIL_ACTIONS_SCOPE,
    onMutate: async ({ threadId, workspace }) => {
      await client.cancelQueries({ queryKey: ["threads"] });
      await client.cancelQueries({ queryKey: keys.thread(threadId), exact: true });
      const snapshot: [QueryKey, unknown][] = [
        ...client.getQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] }),
        ...client.getQueriesData({ queryKey: ["search"] }),
        [keys.thread(threadId), client.getQueryData(keys.thread(threadId))],
      ];
      client.setQueryData<Thread>(keys.thread(threadId), (thread) =>
        thread ? { ...thread, read: true } : thread,
      );
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
      client.setQueriesData<{ results: SearchResult[] }>({ queryKey: ["search"] }, (data) =>
        data
          ? {
              ...data,
              results: data.results.map((hit) =>
                hit.threadId === threadId ? { ...hit, unread: false } : hit,
              ),
            }
          : data,
      );
      return { snapshot, workspace };
    },
    onError: (_error, _vars, context) => {
      if (context?.workspace === currentWorkspaceId()) {
        for (const [key, data] of context.snapshot) client.setQueryData(key, data);
      }
    },
    onSettled: () => settleMailAction(client),
  });
  const { mutate } = mutation;
  return useMemo(
    () => ({ mutate: (vars: MarkRead) => mutate({ ...vars, workspace: currentWorkspaceId() }) }),
    [mutate],
  );
}
