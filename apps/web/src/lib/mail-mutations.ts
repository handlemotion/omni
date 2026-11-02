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

export interface Keyed {
  key: string;
}

/** Retry only when the request may never have arrived; a 4xx/5xx answer will not change. */
const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 3;

const header = (key: string) => ({ "idempotency-key": key });

export const markReadMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "mark-read"],
    retry,
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
      patchThread(client, threadId, { read });
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: () => client.invalidateQueries({ queryKey: keys.counts() }),
  });

export const snoozeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "snooze"],
    retry,
    /** `until: null` unsnoozes. */
    mutationFn: ({ threadId, until, key }: Keyed & { threadId: string; until: Date | null }) =>
      call(
        api.threads[":id"].state.$patch({
          param: { id: threadId },
          header: header(key),
          json: { snoozedUntil: until ? until.toISOString() : null },
        }),
      ),
    onMutate: async ({ threadId, until }) => {
      const snapshot = await snapshotThread(client, threadId);
      const snoozed = until !== null && until.getTime() > Date.now();
      patchThread(client, threadId, { snoozedUntil: until ? until.toISOString() : null });
      removeFromLists(client, threadId, (f) => f.view === (snoozed ? "inbox" : "snoozed"));
      return { snapshot };
    },
    onError: (_error, _vars, context) => restore(client, context?.snapshot),
    onSettled: (_data, _error, { threadId }) => invalidateThread(client, threadId),
  });

export const archiveMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "archive"],
    retry,
    mutationFn: ({ threadId, key }: Keyed & { threadId: string }) =>
      call(api.threads[":id"].archive.$post({ param: { id: threadId }, header: header(key) })),
    onMutate: async ({ threadId }) => {
      const snapshot = await snapshotThread(client, threadId);
      patchThread(client, threadId, { archived: true });
      removeFromLists(client, threadId, (f) => f.view !== "archive");
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
      updatePending(client, threadId, key, { status: "queued", actionId, messageIdHeader });
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
    mutationFn: ({ key, ...json }: SendVariables) =>
      call(api.send.$post({ header: header(key), json })),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.threadLists() }),
  });
