import {
  connectRealtime,
  type Realtime,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeStatus,
} from "@omni/client";
import type { QueryClient } from "@tanstack/react-query";
import { onWake, reportAnswer } from "./connectivity.ts";
import { ApiError } from "./api.ts";
import {
  addFailure,
  addOutstanding,
  allPending,
  failPendingByAction,
  outstandingSends,
  settleOutstanding,
} from "./pending.ts";
import { applyFilePresence, clearFilePresence } from "./file-presence.ts";
import { applyPresence, clearPresence } from "./presence.ts";
import { actionQuery } from "./mail-queries.ts";
import { conversationFilterOf, filterOf, keys } from "./query-keys.ts";

const FLUSH_MS = 150;
const MAX_HOLD_MS = 3_000;

let status: RealtimeStatus = "closed";
let sockets = new Map<string, Realtime>();
const openListeners = new Set<(orgId: string) => void>();
type MergedEvent = Extract<RealtimeEvent, { type: "merged" }>;
const mergeListeners = new Set<(event: MergedEvent) => void>();
type DocEvent = Extract<RealtimeEvent, { type: "doc.record" | "doc.appended" | "doc.refused" }>;
const docListeners = new Set<(event: DocEvent) => void>();
const listeners = new Set<() => void>();

type StorageEvent = DocEvent | Extract<RealtimeEvent, { type: "file.presence" }>;
const isStorageEvent = (event: RealtimeEvent): event is StorageEvent =>
  event.type === "file.presence" || event.type.startsWith("doc.");

function onStorageEvent(orgId: string, event: StorageEvent) {
  if (event.type === "file.presence") return applyFilePresence(orgId, event);
  for (const listener of docListeners) listener(event);
}

function setStatus(next: RealtimeStatus) {
  status = next;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: the socket's state, shared by every component. */
export const realtimeStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The sockets one signed-in shell keeps: the active org's, and the others it follows. */
export interface RealtimeConnections {
  /** Keeps a socket open for exactly these orgs besides the active one, opening or closing. */
  follow(orgIds: readonly string[]): void;
  stop(): void;
}

/**
 * Opens the active org's socket and keeps the cache in step with it and with every org it is
 * told to `follow`. The status shown is the active org's socket.
 */
export function startRealtime(client: QueryClient, activeOrgId: string) {
  const changedThreads = new Set<string>();
  const changedMailboxes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heldSince: number | undefined;

  const flush = () => {
    timer = undefined;
    const acting = client.isMutating({ mutationKey: keys.mail() }) > 0;
    heldSince ??= Date.now();
    if (acting && Date.now() - heldSince < MAX_HOLD_MS) {
      timer = setTimeout(flush, FLUSH_MS);
      return;
    }
    heldSince = undefined;
    const threads = [...changedThreads];
    const mailboxes = new Set(changedMailboxes);
    changedThreads.clear();
    changedMailboxes.clear();
    for (const id of threads) void client.invalidateQueries({ queryKey: keys.thread(id) });
    void client.invalidateQueries({
      queryKey: keys.threadLists(),
      predicate: (query) => {
        const mailbox = filterOf(query.queryKey)?.mailbox;
        return !mailbox || mailboxes.has(mailbox);
      },
    });
    void client.invalidateQueries({ queryKey: keys.counts() });
    void client.invalidateQueries({ queryKey: keys.searches() });
    void client.invalidateQueries({
      queryKey: keys.conversationLists(),
      predicate: (query) => {
        const mailbox = conversationFilterOf(query.queryKey)?.mailbox;
        return !mailbox || mailboxes.has(mailbox);
      },
    });
    void client.invalidateQueries({ queryKey: keys.conversationCounts() });
  };

  const changed = (mailboxId: string, threadIds: readonly string[]) => {
    changedMailboxes.add(mailboxId);
    for (const id of threadIds) changedThreads.add(id);
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  const onEvent = (orgId: string, event: RealtimeEvent) => {
    if (isStorageEvent(event)) return onStorageEvent(orgId, event);
    switch (event.type) {
      case "changed":
      case "thread.changed":
        return changed(event.mailboxId, event.threadIds);
      case "note.created":
        return changed(event.mailboxId, [event.threadId]);
      case "sla.at_risk":
      case "sla.breached":
        return changed(event.mailboxId, [event.threadId]);
      case "merged":
        for (const listener of mergeListeners) listener(event);
        return changed(event.mailboxId, [event.intoThreadId, ...event.fromThreadIds]);
      case "presence":
        return applyPresence(orgId, event);
      case "notification":
      case "notification.removed":
        return void client.invalidateQueries({ queryKey: keys.notifications() });
      case "action.succeeded": {
        settleOutstanding(event.actionId);
        const pending = allPending(client).find((p) => p.actionId === event.actionId);
        if (pending) changed(event.mailboxId, [pending.threadId]);
        return;
      }
      case "action":
        if (event.status === "failed")
          onActionFailed(client, event.actionId, undefined, event.error);
        return;
      case "domain":
        return void client.invalidateQueries({ queryKey: keys.onboarding() });
      case "crm.changed":
        if (orgId !== activeOrgId) return;
        if (event.kind === "contract") void client.invalidateQueries({ queryKey: keys.storage() });
        return void client.invalidateQueries({ queryKey: keys.crm() });
    }
  };

  const connect = (orgId: string) =>
    connectRealtime({
      baseUrl: window.location.origin,
      orgId,
      onEvent: (event) => onEvent(orgId, event),
      onStatus: (next, { reconnected }) => onStatus(orgId, next, reconnected),
    });
  const onStatus = (orgId: string, next: RealtimeStatus, reconnected: boolean) => {
    if (orgId === activeOrgId) setStatus(next);
    if (next === "closed") {
      clearPresence(orgId);
      clearFilePresence(orgId);
    }
    if (next !== "open") return;
    for (const listener of openListeners) listener(orgId);
    void recheckOutstanding(client, orgId);
    reportAnswer();
    if (reconnected) {
      void client.invalidateQueries({ queryKey: keys.mail() }, { cancelRefetch: false });
      void client.invalidateQueries({ queryKey: keys.crm() }, { cancelRefetch: false });
      void recheckPendingSends(client);
    }
  };
  const connections = new Map([[activeOrgId, connect(activeOrgId)]]);
  sockets = connections;
  const stopWaking = onWake(() => {
    for (const connection of connections.values()) connection.wake();
  });

  return {
    follow(orgIds) {
      const wanted = new Set(orgIds.filter((id) => id !== activeOrgId));
      for (const [id, connection] of connections) {
        if (id === activeOrgId || wanted.has(id)) continue;
        connection.close();
        connections.delete(id);
        clearPresence(id);
        clearFilePresence(id);
      }
      for (const id of wanted) if (!connections.has(id)) connections.set(id, connect(id));
    },
    stop() {
      clearTimeout(timer);
      stopWaking();
      if (sockets === connections) sockets = new Map();
      for (const connection of connections.values()) connection.close();
      clearPresence();
      clearFilePresence();
      setStatus("closed");
    },
  } satisfies RealtimeConnections;
}

/**
 * Records every send the outbox takes (its answer names the action and its workspace) until its
 * result comes back, so that workspace's socket stays open for it. Returns the unsubscribe.
 */
export function trackSends(client: QueryClient) {
  return client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const data = event.action.data as { actionId?: unknown; orgId?: unknown } | undefined;
    if (typeof data?.actionId === "string" && typeof data.orgId === "string") {
      addOutstanding({ actionId: data.actionId, orgId: data.orgId });
    }
  }) satisfies () => void;
}

/** Sends on the workspace's socket. False when it is not open (the message is dropped). */
export function sendRealtime(orgId: string, message: RealtimeClientMessage) {
  return sockets.get(orgId)?.send(message) ?? false;
}

/** Calls `listener(event)` when threads are merged, before their queries refetch. */
export const onThreadsMerged: (listener: (event: MergedEvent) => void) => () => void = (
  listener,
) => {
  mergeListeners.add(listener);
  return () => mergeListeners.delete(listener);
};

/** Calls `listener(event)` for every live document event (ADR 0043), from any workspace. */
export const onDocEvent: (listener: (event: DocEvent) => void) => () => void = (listener) => {
  docListeners.add(listener);
  return () => docListeners.delete(listener);
};

/** Calls `listener(orgId)` whenever a workspace's socket opens, including after a reconnect. */
export const onRealtimeOpen: (listener: (orgId: string) => void) => () => void = (listener) => {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
};

function onActionFailed(
  client: QueryClient,
  actionId: string,
  kind: string | undefined,
  error: string,
) {
  settleOutstanding(actionId);
  if (!failPendingByAction(client, actionId, error)) {
    addFailure(client, { actionId, kind, error, at: new Date().toISOString() });
  }
  void client.invalidateQueries({ queryKey: keys.mail() });
}

/** Asks the outbox about queued replies (only `threadId`'s when given); shows any that failed. */
export async function recheckPendingSends(client: QueryClient, threadId?: string) {
  const queued = allPending(client).flatMap((p) =>
    p.status === "queued" && p.actionId && (!threadId || p.threadId === threadId)
      ? [p.actionId]
      : [],
  );
  await Promise.all(
    queued.map(async (actionId) => {
      try {
        const action = await client.fetchQuery({ ...actionQuery(actionId), staleTime: 0 });
        if (action.status === "failed") {
          onActionFailed(client, action.id, action.kind, action.error ?? "Sending failed");
        }
      } catch {}
    }),
  );
}

/**
 * How long after a send its workspace's socket stays open (with no thread of it on screen): the
 * outbox's first try. The socket then closes, so the member is offline there again and gets the
 * push fallback; the send's result is still tracked, over HTTP.
 */
export const SEND_SOCKET_MS = 2 * 60_000;
/** How often outstanding sends are rechecked while any is younger than `SEND_SOCKET_MS`... */
export const RECHECK_SENDS_FAST_MS = 10_000;
/** ...and after: retries back off to minutes, so this does too. */
export const RECHECK_SENDS_SLOW_MS = 60_000;
const TRACK_SENDS_MAX_MS = 90 * 60_000;

/**
 * Asks the outbox about the outstanding sends (only `orgId`'s when given): settles the finished,
 * sent or failed, and reports failures. One past `TRACK_SENDS_MAX_MS` is let go unasked.
 */
export async function recheckOutstanding(client: QueryClient, orgId?: string) {
  const waiting = outstandingSends.get().filter((s) => !orgId || s.orgId === orgId);
  await Promise.all(
    waiting.map(async ({ actionId, since }) => {
      if (Date.now() - since > TRACK_SENDS_MAX_MS) return settleOutstanding(actionId);
      try {
        const action = await client.fetchQuery({ ...actionQuery(actionId), staleTime: 0 });
        if (action.status === "done") settleOutstanding(actionId);
        if (action.status === "failed") {
          onActionFailed(client, action.id, action.kind, action.error ?? "Sending failed");
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) settleOutstanding(actionId);
      }
    }),
  );
}
