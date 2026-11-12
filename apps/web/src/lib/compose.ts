// Writing mail (ADR 0021): staged uploads, signatures, canned replies, recipient autocomplete,
// shared drafts, and sends that wait out the undo window. Queries and mutations only; the
// hooks in `hooks/use-compose.ts` expose them.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, ApiError, call } from "./api.ts";
import { reportAnswer, reportNoAnswer } from "./connectivity.ts";
import { addPending, removePending, updatePending } from "./pending.ts";
import { keys } from "./query-keys.ts";

export type Upload = InferResponseType<Api["uploads"]["$post"], 201>;
export type CannedReply = InferResponseType<Api["canned-replies"]["$get"], 200>["replies"][number];
export type RenderedReply = InferResponseType<Api["canned-replies"][":id"]["render"]["$post"], 200>;
export type Signatures = InferResponseType<
  Api["mailboxes"][":mailboxId"]["signature"]["$get"],
  200
>;
export type CustomerMatch = InferResponseType<Api["customers"]["$get"], 200>["customers"][number];
export type Draft = InferResponseType<Api["drafts"][":id"]["$get"], 200>;
export type DraftContent = Omit<InferRequestType<Api["drafts"][":id"]["$put"]>["json"], "version">;
export type NewDraft = InferRequestType<Api["drafts"]["$post"]>["json"];
export type SendAttachment = NonNullable<
  InferRequestType<Api["send"]["$post"]>["json"]["attachments"]
>[number];
/** What every send answers: the outbox action and until when it can still be stopped. */
export type Queued = InferResponseType<Api["send"]["$post"], 202>;

const retry = (failureCount: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && failureCount < 10;
// One queue with the other mail actions, so sends made offline leave in order (`mail-mutations.ts`).
const scope = { id: "mail-actions" };
const header = (key: string) => ({ "idempotency-key": key });

/**
 * Streams one file into R2 for a later send. XHR rather than fetch: only XHR reports upload
 * progress. `onProgress` gets 0..1. Abort with `signal` when the composer drops the file.
 */
export function uploadFile(
  mailboxId: string,
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<Upload> {
  const url = api.uploads.$url({ query: { mailboxId, filename: file.name } });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url.pathname + url.search);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      reportAnswer();
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status === 201) return resolve(body as Upload);
      const message =
        typeof body === "object" && body && "error" in body
          ? String((body as { error: unknown }).error)
          : `upload failed (${xhr.status})`;
      reject(new ApiError(xhr.status, message));
    };
    xhr.onerror = () => {
      reportNoAnswer();
      reject(new ApiError(0, "upload failed: no connection"));
    };
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Removes a staged file the composer dropped. A file a send already took is kept (404). */
export const discardUpload = (id: string) =>
  call(api.uploads[":id"].$delete({ param: { id } })).catch(() => undefined);

/** The inbox's signature and the member's own on it. */
export const signaturesQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.signatures(mailboxId),
    queryFn: ({ signal }) =>
      call(
        api.mailboxes[":mailboxId"].signature.$get({ param: { mailboxId } }, { init: { signal } }),
      ),
    staleTime: 5 * 60_000,
  });

/** The text the composer starts a message with: the member's own signature, else the inbox's. */
export function signatureText(signatures: Signatures | undefined): string | null {
  const own = signatures?.mine?.bodyText.trim();
  const inbox = signatures?.inbox?.bodyText.trim();
  return own || inbox || null;
}

/** The inbox's canned replies and the member's own, by title. */
export const cannedRepliesQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.cannedReplies(mailboxId),
    queryFn: ({ signal }) =>
      call(api["canned-replies"].$get({ query: { mailboxId } }, { init: { signal } })),
    select: (data) => data.replies,
    staleTime: 60_000,
  });

/** A canned reply filled in for one conversation. Not cached: customer and agent can change. */
export const renderCannedReply = (id: string, threadId: string) =>
  call(api["canned-replies"][":id"].render.$post({ param: { id }, json: { threadId } }));

/** Recipient autocomplete over customers the member can see. */
export const customerSearchQuery = (q: string) =>
  queryOptions({
    queryKey: keys.customerSearch(q),
    queryFn: ({ signal }) =>
      call(api.customers.$get({ query: { q, limit: "8" } }, { init: { signal } })),
    select: (data) => data.customers,
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });

/** Shared drafts of one conversation (or, with `mailboxId`, new mail on an inbox). */
export const draftsQuery = (where: { threadId: string } | { mailboxId: string }) =>
  queryOptions({
    queryKey: keys.drafts(where),
    queryFn: ({ signal }) => call(api.drafts.$get({ query: where }, { init: { signal } })),
    select: (data) => data.drafts,
  });

export const createDraft = (json: NewDraft) => call(api.drafts.$post({ json }));

/**
 * Autosave. A teammate's newer save answers 409; the error carries their draft so the composer
 * can take it over instead of overwriting it.
 */
export async function saveDraft(
  id: string,
  version: number,
  content: DraftContent,
): Promise<{ conflict: Draft } | { draft: Draft }> {
  const response = await api.drafts[":id"].$put({ param: { id }, json: { ...content, version } });
  if (response.status === 409) {
    const body = (await response.json()) as { draft: Draft };
    reportAnswer();
    return { conflict: body.draft };
  }
  return { draft: (await call(Promise.resolve(response))) as Draft };
}

export const deleteDraft = (id: string) =>
  call(api.drafts[":id"].$delete({ param: { id } })).catch(() => undefined);

/** Stops a send inside its undo window. Answers `false` when it already left. */
export async function cancelSend(actionId: string): Promise<boolean> {
  try {
    await call(api.actions[":id"].cancel.$post({ param: { id: actionId } }));
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 404)) return false;
    throw error;
  }
}

interface Recipients {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
}

export interface ComposeReplyVariables extends Recipients {
  key: string;
  threadId: string;
  text: string;
  html?: string | undefined;
  replyAll?: boolean | undefined;
  /** The message replied to; the latest when absent. */
  messageId?: string | undefined;
  attachments?: SendAttachment[] | undefined;
  /** Sends the shared draft instead, which deletes it in the same transaction. */
  draftId?: string | undefined;
}

/**
 * A reply from the composer: recipients, attachments, the message replied to, or a shared draft.
 * Like `replyMutation`, it shows at once as a pending send in the thread.
 */
export const composeReplyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "reply"],
    retry,
    scope,
    mutationFn: ({
      key,
      threadId,
      draftId,
      attachments = [],
      replyAll = false,
      ...rest
    }: ComposeReplyVariables) =>
      draftId
        ? call(api.drafts[":id"].send.$post({ param: { id: draftId }, header: header(key) }))
        : call(
            api.threads[":id"].reply.$post({
              param: { id: threadId },
              header: header(key),
              json: { ...compact(rest), replyAll, attachments },
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
    onSuccess: ({ actionId, messageIdHeader }, { threadId, key, draftId }) => {
      updatePending(client, threadId, key, {
        status: "queued",
        actionId,
        messageIdHeader: messageIdHeader ?? undefined,
      });
      if (draftId) void client.invalidateQueries({ queryKey: keys.draftLists() });
    },
    onError: (error, { threadId, key }) => {
      updatePending(client, threadId, key, { status: "failed", error: error.message });
    },
  });

export interface ForwardVariables extends Recipients {
  key: string;
  threadId: string;
  to: string[];
  text: string;
  messageId?: string | undefined;
  /** Keep the original's files. */
  includeAttachments?: boolean | undefined;
  attachments?: SendAttachment[] | undefined;
  draftId?: string | undefined;
}

/** Forwards a message (the latest by default) with what the agent wrote above it. */
export const forwardMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "forward"],
    retry,
    scope,
    mutationFn: ({
      key,
      threadId,
      draftId,
      attachments = [],
      includeAttachments = true,
      ...rest
    }: ForwardVariables) =>
      draftId
        ? call(api.drafts[":id"].send.$post({ param: { id: draftId }, header: header(key) }))
        : call(
            api.threads[":id"].forward.$post({
              param: { id: threadId },
              header: header(key),
              json: { ...compact(rest), to: rest.to, includeAttachments, attachments },
            }),
          ),
    onSettled: (_data, _error, { threadId }) => {
      void client.invalidateQueries({ queryKey: keys.draftLists() });
      void client.invalidateQueries({ queryKey: keys.thread(threadId) });
    },
  });

export interface NewMailVariables {
  key: string;
  mailboxId: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  text: string;
  attachments?: SendAttachment[] | undefined;
  draftId?: string | undefined;
}

/** New mail from one of the member's mailboxes. */
export const newMailMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: [...keys.mail(), "send"],
    retry,
    scope,
    mutationFn: ({ key, draftId, attachments = [], ...rest }: NewMailVariables) =>
      draftId
        ? call(api.drafts[":id"].send.$post({ param: { id: draftId }, header: header(key) }))
        : call(
            api.send.$post({
              header: header(key),
              json: {
                ...compact(rest),
                to: rest.to,
                mailboxId: rest.mailboxId,
                subject: rest.subject,
                text: rest.text,
                attachments,
              },
            }),
          ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.draftLists() });
      void client.invalidateQueries({ queryKey: keys.threadLists() });
    },
  });

/** Drops a cancelled reply's pending bubble. */
export function forgetPending(client: QueryClient, threadId: string, key: string) {
  removePending(client, threadId, key);
}

/** Drops empty lists and undefined fields, so payloads match what the routes expect. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0),
    ),
  ) as T;
}
