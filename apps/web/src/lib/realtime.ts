// Live updates: one websocket per signed-in member (per org; the Durable Object is per org),
// turned into cache invalidations. Events say what changed, not its contents, so this marks
// those queries stale and TanStack Query refetches only the ones on screen.
import { connectRealtime, type RealtimeEvent, type RealtimeStatus } from "@omni/client";
import type { QueryClient } from "@tanstack/react-query";
import { call, api } from "./api.ts";
import { onWake, reportAnswer } from "./connectivity.ts";
import { addFailure, allPending, failPendingByAction } from "./pending.ts";
import { filterOf, keys } from "./query-keys.ts";

/** Bursts of new mail (an import, a busy thread) collapse into one refetch per window. */
const FLUSH_MS = 150;

let status: RealtimeStatus = "closed";
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

/** Opens the socket and keeps the cache in step with it. Returns the function that stops it. */
export function startRealtime(client: QueryClient): () => void {
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

  const onEvent = (event: RealtimeEvent) => {
    if (event.type === "changed") {
      changedMailboxes.add(event.mailboxId);
      for (const id of event.threadIds) changedThreads.add(id);
      timer ??= setTimeout(flush, FLUSH_MS);
      return;
    }
    if (event.type === "action" && event.status === "failed") {
      onActionFailed(client, event.actionId, undefined, event.error);
    }
    // A domain's DNS was checked again (the DNS page's auto-check): refetch its verdicts.
    if (event.type === "domain") void client.invalidateQueries({ queryKey: keys.onboarding() });
  };

  const connection = connectRealtime({
    baseUrl: window.location.origin,
    onEvent,
    onStatus: (next, { reconnected }) => {
      setStatus(next);
      if (next !== "open") return;
      // The Worker answered. Going online resumes paused mutations and refetches stale queries.
      reportAnswer();
      // Events sent while the socket was down are gone: mark all mail stale. Only queries on
      // screen refetch now (the rest when next shown), and one already refetching because the
      // app just came online is joined, not cancelled and sent again. Then ask the outbox
      // about sends still waiting.
      if (reconnected) {
        void client.invalidateQueries({ queryKey: keys.mail() }, { cancelRefetch: false });
        void recheckPendingSends(client);
      }
    },
  });
  const stopWaking = onWake(() => connection.wake());

  return () => {
    clearTimeout(timer);
    stopWaking();
    connection.close();
    setStatus("closed");
  };
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
  const queued = allPending(client).filter((p) => p.status === "queued" && p.actionId);
  await Promise.all(
    queued.map(async (p) => {
      try {
        const action = await call(api.actions[":id"].$get({ param: { id: p.actionId ?? "" } }));
        if (action.status === "failed") {
          onActionFailed(client, action.id, action.kind, action.error ?? "Sending failed");
        }
      } catch {
        // Offline again; the next reconnect checks again.
      }
    }),
  );
}
