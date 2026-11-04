// Write operations, as `mutationOptions` with optimistic updates. Every variables object carries
// its idempotency `key`: TanStack's automatic retries reuse the same variables, so a retried
// request never becomes a second action. The hooks in `src/hooks` mint the key per user intent.
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import {
  patchThread,
  removeFromLists,
  restore,
  snapshotThread,
  invalidateThread,
} from "./cache.ts";
import { addPending, updatePending } from "./pending.ts";
import { keys } from "./query-keys.ts";
import { leavesView } from "./threads.ts";

export interface Keyed {
  key: string;
}

/**
 * Retry only when the request may never have arrived; a 4xx/5xx answer will not change. A request
 * without an answer also marks the app offline (`connectivity.ts`), so the retry waits, paused,
 * until the API answers again: a send made offline goes out once the connection is back. The cap
 * only stops a request that fails while everything else gets through.
 */
const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 10;

/**
 * Every mail action shares one scope, so they run one at a time in the order they were made:
 * queued offline, "defer" then "done" still lands in that order when they flush.
 */
const scope = { id: "mail-actions" };

const header = (key: string) => ({ "idempotency-key": key });

export const markReadMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "mark-read"],
    retry,
    scope,
    mutationFn: ({ threadId, read, key }: Keyed & { threadId: string; read: boolean }) =>
      call(
        api.threads[":id"].state.$patch({
          param: { id: threadId },
          header: header(key),
          json: { read },
        }),
      ),
    onMutate: async ({ threadId, read }) => {
      const snapshot = await snapshotThread(client, threadId);
      // List rows carry `unread` as well as `read`; patch both so the dot goes at once.
      patchThread(client, threadId, { read, unread: !read });
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: keys.counts() }),
  });

/** Into the Queue until `until`; `until: null` puts it back in the Inbox now. Clears done. */
export const deferMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "defer"],
    retry,
    scope,
    mutationFn: ({ threadId, until, key }: Keyed & { threadId: string; until: Date | null }) =>
      until
        ? call(
            api.threads[":id"].defer.$post({
              param: { id: threadId },
              header: header(key),
              json: { until: until.toISOString() },
            }),
          )
        : call(api.threads[":id"].defer.$delete({ param: { id: threadId }, header: header(key) })),
    onMutate: async ({ threadId, until }) => {
      const snapshot = await snapshotThread(client, threadId);
      const deferred = until !== null && until.getTime() > Date.now();
      patchThread(client, threadId, {
        deferredUntil: until ? until.toISOString() : null,
        ...(until ? { done: false } : {}),
      });
      removeFromLists(client, threadId, (f) => leavesView(deferred ? "defer" : "undefer", f.view));
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

/**
 * Done through `through`: the thread's `lastMessageAt` as shown. Leaves the Inbox and Queue for
 * this member only. A newer message brings it back; if one arrived after `through`, the server
 * answers `done: false` and the refetch puts the thread back.
 */
export const doneMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "done"],
    retry,
    scope,
    mutationFn: ({ threadId, through, key }: Keyed & { threadId: string; through: string }) =>
      call(
        api.threads[":id"].done.$post({
          param: { id: threadId },
          header: header(key),
          json: { through },
        }),
      ),
    onMutate: async ({ threadId }) => {
      const snapshot = await snapshotThread(client, threadId);
      patchThread(client, threadId, { done: true, deferredUntil: null });
      removeFromLists(client, threadId, (f) => leavesView("done", f.view));
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

/** Not done: back in the Inbox. */
export const undoneMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "undone"],
    retry,
    scope,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].done.$delete({ param: { id: threadId }, header: header(key) })),
    onMutate: async ({ threadId }) => {
      const snapshot = await snapshotThread(client, threadId);
      patchThread(client, threadId, { done: false });
      removeFromLists(client, threadId, (f) => leavesView("undone", f.view));
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

export const archiveMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "archive"],
    retry,
    scope,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].archive.$post({ param: { id: threadId }, header: header(key) })),
    onMutate: async ({ threadId }) => {
      const snapshot = await snapshotThread(client, threadId);
      patchThread(client, threadId, { archived: true });
      removeFromLists(client, threadId, (f) => leavesView("archive", f.view));
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

/** Moves the thread's messages to another IMAP folder. Not optimistic: no list shows folders. */
export const moveMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "move"],
    retry,
    scope,
    mutationFn: ({
      threadId,
      destination,
      key,
    }: Keyed & { threadId: string; destination: string }) =>
      call(
        api.threads[":id"].move.$post({
          param: { id: threadId },
          header: header(key),
          json: { destination },
        }),
      ),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

export interface ReplyVariables extends Keyed {
  threadId: string;
  text: string;
  html?: string | undefined;
  replyAll?: boolean | undefined;
}

/**
 * Replies to the thread's latest message. The reply shows at once as a pending send (see
 * `pending.ts`); the real message replaces it when it arrives, matched by Message-ID.
 */
export const replyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "reply"],
    retry,
    scope,
    mutationFn: ({ threadId, text, html, replyAll = false, key }: ReplyVariables) =>
      call(
        api.threads[":id"].reply.$post({
          param: { id: threadId },
          header: header(key),
          json: { text, replyAll, ...(html ? { html } : {}) },
        }),
      ),
    onMutate: ({ threadId, text, html, replyAll = false, key }) => {
      addPending(client, {
        key,
        threadId,
        text,
        html,
        replyAll,
        createdAt: new Date().toISOString(),
        status: "sending",
      });
    },
    onSuccess: ({ actionId, messageIdHeader }, { threadId, key }) => {
      // A null Message-ID (should not happen for a reply) leaves the entry until the user discards it.
      updatePending(client, threadId, key, {
        status: "queued",
        actionId,
        messageIdHeader: messageIdHeader ?? undefined,
      });
    },
    onError: (error, { threadId, key }) => {
      updatePending(client, threadId, key, { status: "failed", error: error.message });
    },
  });

export interface SendVariables extends Keyed {
  mailboxId: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
}

/**
 * Sends a new message. It has no thread until the mail service files it, so there is no pending
 * bubble; a later failure arrives as an action failure (`useActionFailures`).
 */
export const sendMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "send"],
    retry,
    scope,
    mutationFn: ({ key, ...json }: SendVariables) =>
      call(api.send.$post({ header: header(key), json })),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.threadLists() }),
  });
