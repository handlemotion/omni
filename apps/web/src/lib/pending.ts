// Client-only state kept in the query cache: sends that have not arrived as messages yet, and
// actions the outbox gave up on. Living in the cache means hooks subscribe to it like any query,
// and an organization or account switch clears it with everything else.
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./query-keys.ts";

export interface PendingSend {
  /** The send's idempotency key; stable, so use it as the React key. */
  key: string;
  threadId: string;
  text: string;
  html?: string | undefined;
  replyAll: boolean;
  createdAt: string;
  /**
   * `sending`: the request is in flight. `queued`: the outbox accepted it and the mail service
   * will send it. `failed`: the request or the outbox gave up; `error` says why.
   */
  status: "sending" | "queued" | "failed";
  actionId?: string | undefined;
  messageIdHeader?: string | undefined;
  error?: string | undefined;
}

/** An outbox action that failed for good, for the UI to surface (toast, banner). */
export interface ActionFailure {
  actionId: string;
  kind: string;
  error: string;
  at: string;
}

export function pendingFor(client: QueryClient, threadId: string): PendingSend[] {
  return client.getQueryData<PendingSend[]>(keys.pending(threadId)) ?? [];
}

export function addPending(client: QueryClient, pending: PendingSend) {
  client.setQueryData<PendingSend[]>(keys.pending(pending.threadId), (list = []) => [
    ...list.filter((p) => p.key !== pending.key),
    pending,
  ]);
}

export function updatePending(
  client: QueryClient,
  threadId: string,
  key: string,
  patch: Partial<PendingSend>,
) {
  client.setQueryData<PendingSend[]>(keys.pending(threadId), (list = []) =>
    list.map((p) => (p.key === key ? { ...p, ...patch } : p)),
  );
}

export function removePending(client: QueryClient, threadId: string, key: string) {
  client.setQueryData<PendingSend[]>(keys.pending(threadId), (list = []) =>
    list.filter((p) => p.key !== key),
  );
}

/** Drops pending sends whose message is now in the thread. */
export function prunePending(
  client: QueryClient,
  threadId: string,
  messages: readonly { messageIdHeader: string }[],
) {
  const list = pendingFor(client, threadId);
  if (list.length === 0) return;
  const arrived = new Set(messages.map((m) => m.messageIdHeader));
  const left = list.filter((p) => !p.messageIdHeader || !arrived.has(p.messageIdHeader));
  if (left.length !== list.length) client.setQueryData(keys.pending(threadId), left);
}

/** Every pending send in every thread. */
export function allPending(client: QueryClient): PendingSend[] {
  return client
    .getQueriesData<PendingSend[]>({ queryKey: keys.pendingAll() })
    .flatMap(([, list]) => list ?? []);
}

/** Marks the pending send for this action failed. Returns false when no pending send has it. */
export function failPendingByAction(client: QueryClient, actionId: string, error: string) {
  const pending = allPending(client).find((p) => p.actionId === actionId);
  if (!pending) return false;
  updatePending(client, pending.threadId, pending.key, { status: "failed", error });
  return true;
}

export function addFailure(client: QueryClient, failure: ActionFailure) {
  client.setQueryData<ActionFailure[]>(keys.failures(), (list = []) => [
    ...list.filter((f) => f.actionId !== failure.actionId),
    failure,
  ]);
}

export function dismissFailure(client: QueryClient, actionId: string) {
  client.setQueryData<ActionFailure[]>(keys.failures(), (list = []) =>
    list.filter((f) => f.actionId !== actionId),
  );
}
