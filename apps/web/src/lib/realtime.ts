// Live updates: one websocket per workspace the user belongs to (the Durable Object is per org,
// and lists span every workspace, ADR 0014), turned into cache invalidations. Events say what changed, not its contents, so this marks
// those queries stale and TanStack Query refetches only the ones on screen.
import {
  connectRealtime,
  type Realtime,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeStatus,
} from "@omni/client";
import type { QueryClient } from "@tanstack/react-query";
import { onWake, reportAnswer } from "./connectivity.ts";
import { addFailure, allPending, failPendingByAction } from "./pending.ts";
import { applyPresence, clearPresence } from "./presence.ts";
import { actionQuery } from "./mail-queries.ts";
import { filterOf, keys } from "./query-keys.ts";

/** Bursts of new mail (an import, a busy thread) collapse into one refetch per window. */
const FLUSH_MS = 150;

let status: RealtimeStatus = "closed";
/** The open sockets by org, so a message about a conversation goes to its workspace. */
let sockets = new Map<string, Realtime>();
const openListeners = new Set<(orgId: string) => void>();
const listeners = new Set<() => void>();

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

/**
 * Opens a socket per org in `orgIds` and keeps the cache in step with them. The status shown is
 * the active org's socket. Returns the function that stops them all.
 */
export function startRealtime(
  client: QueryClient,
  orgIds: readonly string[],
  activeOrgId: string,
): () => void {
  const changedThreads = new Set<string>();
  const changedMailboxes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    const threads = [...changedThreads];
    const mailboxes = new Set(changedMailboxes);
    changedThreads.clear();
    changedMailboxes.clear();
    for (const id of threads) void client.invalidateQueries({ queryKey: keys.thread(id) });
    // A list filtered to another mailbox cannot have changed.
    void client.invalidateQueries({
      queryKey: keys.threadLists(),
      predicate: (query) => {
        const mailbox = filterOf(query.queryKey)?.mailbox;
        return !mailbox || mailboxes.has(mailbox);
      },
    });
    void client.invalidateQueries({ queryKey: keys.counts() });
    void client.invalidateQueries({ queryKey: keys.searches() });
  };

  const changed = (mailboxId: string, threadIds: readonly string[]) => {
    changedMailboxes.add(mailboxId);
    for (const id of threadIds) changedThreads.add(id);
    timer ??= setTimeout(flush, FLUSH_MS);
  };

  const onEvent = (orgId: string, event: RealtimeEvent) => {
    switch (event.type) {
      // New mail, or the conversation's status, assignee, priority, tags or snooze changed.
      case "changed":
      case "thread.changed":
        return changed(event.mailboxId, event.threadIds);
      // A note is part of the thread's timeline (its queries sit under `keys.thread`).
      case "note.created":
        return changed(event.mailboxId, [event.threadId]);
      // The thread's due times and the inbox's "SLA at risk" view and count moved.
      case "sla.at_risk":
      case "sla.breached":
        return changed(event.mailboxId, [event.threadId]);
      case "presence":
        return applyPresence(orgId, event);
      case "action.succeeded": {
        // A reply went out: refetch its thread now rather than waiting for the sync's event.
        const pending = allPending(client).find((p) => p.actionId === event.actionId);
        if (pending) changed(event.mailboxId, [pending.threadId]);
        return;
      }
      case "action":
        if (event.status === "failed")
          onActionFailed(client, event.actionId, undefined, event.error);
        return;
      // A domain's DNS was checked again (the DNS page's auto-check): refetch its verdicts.
      case "domain":
        return void client.invalidateQueries({ queryKey: keys.onboarding() });
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
    // Teammates' `left` may be lost while the socket is down; they reappear on their next repeat.
    if (next === "closed") clearPresence(orgId);
    if (next !== "open") return;
    for (const listener of openListeners) listener(orgId);
    // The Worker answered. Going online resumes paused mutations and refetches stale queries.
    reportAnswer();
    // Events sent while the socket was down are gone: mark all mail stale. Only queries on
    // screen refetch now (the rest when next shown), and one already refetching because the
    // app just came online is joined, not cancelled and sent again. Then ask the outbox about
    // sends still waiting.
    if (reconnected) {
      void client.invalidateQueries({ queryKey: keys.mail() }, { cancelRefetch: false });
      void recheckPendingSends(client);
    }
  };
  const connections = new Map(
    [...new Set([activeOrgId, ...orgIds])].map((id) => [id, connect(id)]),
  );
  sockets = connections;
  const stopWaking = onWake(() => {
    for (const connection of connections.values()) connection.wake();
  });

  return () => {
    clearTimeout(timer);
    stopWaking();
    if (sockets === connections) sockets = new Map();
    for (const connection of connections.values()) connection.close();
    clearPresence();
    setStatus("closed");
  };
}

/** Sends on the workspace's socket. False when it is not open (the message is dropped). */
export function sendRealtime(orgId: string, message: RealtimeClientMessage): boolean {
  return sockets.get(orgId)?.send(message) ?? false;
}

/** Calls `listener(orgId)` whenever a workspace's socket opens, including after a reconnect. */
export function onRealtimeOpen(listener: (orgId: string) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

function onActionFailed(
  client: QueryClient,
  actionId: string,
  kind: string | undefined,
  error: string,
) {
  // A failed reply shows on its pending bubble; anything else is reported as a failure, and the
  // lists refetch because an optimistic archive or move may not have happened after all.
  if (!failPendingByAction(client, actionId, error)) {
    addFailure(client, { actionId, kind, error, at: new Date().toISOString() });
  }
  void client.invalidateQueries({ queryKey: keys.mail() });
}

async function recheckPendingSends(client: QueryClient) {
  const queued = allPending(client).flatMap((p) =>
    p.status === "queued" && p.actionId ? [p.actionId] : [],
  );
  await Promise.all(
    queued.map(async (actionId) => {
      try {
        // Always ask the server: the point is to learn what happened while we were away.
        const action = await client.fetchQuery({ ...actionQuery(actionId), staleTime: 0 });
        if (action.status === "failed") {
          onActionFailed(client, action.id, action.kind, action.error ?? "Sending failed");
        }
      } catch {
        // Offline again; the next reconnect checks again.
      }
    }),
  );
}
