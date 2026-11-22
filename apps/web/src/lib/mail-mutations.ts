import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import {
  applyEffect,
  invalidateThread,
  restoreFailed,
  snapshotThread,
  type Snapshot,
  type ThreadEffect,
} from "./cache.ts";
import { addPending, updatePending } from "./pending.ts";
import { keys } from "./query-keys.ts";
import { leavesView } from "./threads.ts";

export interface Keyed {
  key: string;
}

const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 10;

const scope = { id: "mail-actions" };

const header = (key: string) => ({ "idempotency-key": key });

function optimistic<V extends Keyed & { threadId: string }>(
  client: QueryClient,
  effect: (variables: V) => ThreadEffect,
) {
  return {
    meta: { optimistic: effect },
    onMutate: async (variables: V) => {
      const snapshot = await snapshotThread(client, variables.threadId);
      applyEffect(client, effect(variables));
      return { snapshot };
    },
    onError: (_error: Error, variables: V, result: { snapshot: Snapshot } | undefined) =>
      restoreFailed(client, result?.snapshot, variables),
    onSettled: (_data: unknown, _error: unknown, { threadId }: V) =>
      void invalidateThread(client, threadId),
  };
}

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
    ...optimistic(client, ({ threadId, read }: Keyed & { threadId: string; read: boolean }) => ({
      threadId,
      patch: { read, unread: !read },
    })),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.counts() }),
  });

/** `later: true` moves it into Later (clears done); `false` puts it back in the Inbox. */
export const laterMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "later"],
    retry,
    scope,
    mutationFn: ({ threadId, later, key }: Keyed & { threadId: string; later: boolean }) => {
      const route = api.threads[":id"].later;
      const request = { param: { id: threadId }, header: header(key) };
      return call(later ? route.$post(request) : route.$delete(request));
    },
    ...optimistic(client, ({ threadId, later }: Keyed & { threadId: string; later: boolean }) => ({
      threadId,
      patch: { later, ...(later ? { done: false } : {}) },
      leaves: (view) => leavesView(later ? "later" : "unlater", view),
    })),
  });

/**
 * Done through `through`: the thread's `lastMessageAt` as shown. Leaves the Inbox and Later for
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
    ...optimistic(client, ({ threadId }: Keyed & { threadId: string; through: string }) => ({
      threadId,
      patch: { done: true, later: false },
      leaves: (view) => leavesView("done", view),
    })),
  });

/** Not done: back in the Inbox. */
export const undoneMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "undone"],
    retry,
    scope,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].done.$delete({ param: { id: threadId }, header: header(key) })),
    ...optimistic(client, ({ threadId }: Keyed & { threadId: string }) => ({
      threadId,
      patch: { done: false },
      leaves: (view) => leavesView("undone", view),
    })),
  });

export const archiveMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "archive"],
    retry,
    scope,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].archive.$post({ param: { id: threadId }, header: header(key) })),
    ...optimistic(client, ({ threadId }: Keyed & { threadId: string }) => ({
      threadId,
      patch: { archived: true },
      leaves: (view) => leavesView("archive", view),
    })),
  });

/** Moves every copy of the thread to the mailbox's Trash; it leaves the Inbox for everyone. */
export const trashMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "trash"],
    retry,
    scope,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].trash.$post({ param: { id: threadId }, header: header(key) })),
    ...optimistic(client, ({ threadId }: Keyed & { threadId: string }) => ({
      threadId,
      patch: { archived: true },
      leaves: (view) => leavesView("trash", view),
    })),
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
    onSettled: (_data, _error, { threadId }) => void invalidateThread(client, threadId),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.threadLists() }),
  });

/**
 * Leaves the mailing list `messageId` came from: the Worker posts the list's one-click URL or
 * queues its unsubscribe email. A list that only offers a page is opened by the app instead.
 */
export const unsubscribeMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationKey: [...keys.mail(), "unsubscribe"],
    retry,
    scope,
    mutationFn: ({ threadId, messageId, key }: Keyed & { threadId: string; messageId: string }) =>
      call(
        api.threads[":id"].unsubscribe.$post({
          param: { id: threadId },
          header: header(key),
          json: { messageId },
        }),
      ),
    onSuccess: (_data, { threadId }) => void invalidateThread(client, threadId),
  });
