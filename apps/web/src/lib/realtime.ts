// Live updates: the active workspace's websocket (the Durable Object is per org, and lists show
// only the active workspace, ADR 0014 as amended), plus any other workspace the app follows for
// a while (`follow`), turned into cache invalidations. Events say what changed, not its contents,
// so this marks those queries stale and TanStack Query refetches only the ones on screen.
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

/** Bursts of new mail (an import, a busy thread) collapse into one refetch per window. */
const FLUSH_MS = 150;

let status: RealtimeStatus = "closed";
/** The open sockets by org, so a message about a conversation goes to its workspace. */
let sockets = new Map<string, Realtime>();
const openListeners = new Set<(orgId: string) => void>();
type MergedEvent = Extract<RealtimeEvent, { type: "merged" }>;
const mergeListeners = new Set<(event: MergedEvent) => void>();
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
export function startRealtime(client: QueryClient, activeOrgId: string): RealtimeConnections {
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
      // Threads became one: readers of the absorbed ones follow before their queries refetch
      // (and 404), then every one of them refetches.
      case "merged":
        for (const listener of mergeListeners) listener(event);
        return changed(event.mailboxId, [event.intoThreadId, ...event.fromThreadIds]);
      case "presence":
        return applyPresence(orgId, event);
      // Someone has a Drive file open in their editor, or closed it.
      case "file.presence":
        return applyFilePresence(orgId, event);
      // You were assigned, mentioned, or a customer replied: refetch your notifications.
      case "notification":
      // One you had was withdrawn (its note was deleted).
      case "notification.removed":
        return void client.invalidateQueries({ queryKey: keys.notifications() });
      case "action.succeeded": {
        settleOutstanding(event.actionId);
        // A reply went out: refetch its thread now rather than waiting for the sync's event. (No
        // sender emits this yet; outstanding sends are settled by `recheckOutstanding`.)
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
      // A teammate (or an agent) changed the CRM: what is on screen refetches. A contract's
      // signing locked its file, so Storage refetches too. Only the active workspace's CRM is
      // cached.
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
    // Teammates' `left` may be lost while the socket is down; they reappear on their next repeat.
    if (next === "closed") {
      clearPresence(orgId);
      clearFilePresence(orgId);
    }
    if (next !== "open") return;
    for (const listener of openListeners) listener(orgId);
    // A send's result may have come while no socket of its org was open.
    void recheckOutstanding(client, orgId);
    // The Worker answered. Going online resumes paused mutations and refetches stale queries.
    reportAnswer();
    // Events sent while the socket was down are gone: mark all mail stale. Only queries on
    // screen refetch now (the rest when next shown), and one already refetching because the
    // app just came online is joined, not cancelled and sent again. Then ask the outbox about
    // sends still waiting.
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
  };
}

/**
 * Records every send the outbox takes (its answer names the action and its workspace) until its
 * result comes back, so that workspace's socket stays open for it. Returns the unsubscribe.
 */
export function trackSends(client: QueryClient): () => void {
  return client.getMutationCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const data = event.action.data as { actionId?: unknown; orgId?: unknown } | undefined;
    if (typeof data?.actionId === "string" && typeof data.orgId === "string") {
      addOutstanding({ actionId: data.actionId, orgId: data.orgId });
    }
  });
}

/** Sends on the workspace's socket. False when it is not open (the message is dropped). */
export function sendRealtime(orgId: string, message: RealtimeClientMessage): boolean {
  return sockets.get(orgId)?.send(message) ?? false;
}

/** Calls `listener(event)` when threads are merged, before their queries refetch. */
export function onThreadsMerged(listener: (event: MergedEvent) => void): () => void {
  mergeListeners.add(listener);
  return () => mergeListeners.delete(listener);
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
  settleOutstanding(actionId);
  // A failed reply shows on its pending bubble; anything else is reported as a failure, and the
  // lists refetch because an optimistic archive or move may not have happened after all.
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
/**
 * When tracking gives up on a send. The outbox's longest retry chain (`apps/mail/src/outbox.ts`):
 * an undo window of at most 30 s, then 8 attempts, each up to the 5 min claim lease if it hangs
 * (40 min), with waits of `5 s + min(30 min, 5 s × 2^n)` between attempts 1 to 7 (at most 1,305 s,
 * about 22 min): about 63 min. 90 min covers it. A send deferred because its mailbox or domain is
 * unavailable spends no attempts and can wait longer: past this it is dropped as a reload would
 * drop it (a new email: nothing shows; a reply: its bubble stays as it is until the thread is
 * opened again or the socket reconnects, which ask again).
 */
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
        // Gone: undone inside its window. Anything else (offline): the next check asks again.
        if (error instanceof ApiError && error.status === 404) settleOutstanding(actionId);
      }
    }),
  );
}
