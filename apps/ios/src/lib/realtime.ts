import { connectRealtime, type Realtime, type RealtimeEvent } from "@omni/client";
import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { auth } from "./api.ts";
import { config } from "./config.ts";
import { MAIL_ACTIONS_KEY } from "./mail.ts";
import { keys } from "./query-keys.ts";

const NativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: null,
  options: { headers: Record<string, string> },
) => WebSocket;

const COALESCE_EVENTS_MS = 150;
const MAX_HOLD_MS = 3_000;

const threadListMailbox = (query: Query) => query.queryKey[2];
const isThreadNotItsHtml = (query: Query) => query.queryKey.length === 2;

function refetchAfterMissedEvents(client: QueryClient) {
  const quiet = { cancelRefetch: false };
  void client.invalidateQueries({ queryKey: keys.threadLists() }, quiet);
  void client.invalidateQueries(
    { queryKey: keys.threadDetails(), predicate: isThreadNotItsHtml },
    quiet,
  );
  void client.invalidateQueries({ queryKey: keys.conversations() }, quiet);
  void client.invalidateQueries({ queryKey: ["search"] }, quiet);
  void client.invalidateQueries({ queryKey: keys.counts() }, quiet);
  void client.invalidateQueries({ queryKey: keys.mailboxes() }, quiet);
  void client.invalidateQueries({ queryKey: keys.driveAll() }, quiet);
  void client.invalidateQueries({ queryKey: keys.crmAll() }, quiet);
}

function invalidateOnEvents(client: QueryClient) {
  const threads = new Set<string>();
  const mailboxes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heldSince: number | undefined;

  const flush = () => {
    timer = undefined;
    const acting = client.isMutating({ mutationKey: MAIL_ACTIONS_KEY }) > 0;
    heldSince ??= Date.now();
    if (acting && Date.now() - heldSince < MAX_HOLD_MS) {
      timer = setTimeout(flush, COALESCE_EVENTS_MS);
      return;
    }
    heldSince = undefined;
    const changed = new Set(mailboxes);
    for (const id of threads) {
      void client.invalidateQueries({ queryKey: keys.thread(id), exact: true });
      void client.invalidateQueries({ queryKey: keys.conversation(id) });
    }
    threads.clear();
    mailboxes.clear();
    void client.invalidateQueries({
      queryKey: keys.threadLists(),
      predicate: (query) => {
        const mailbox = threadListMailbox(query);
        return mailbox === "all" || (typeof mailbox === "string" && changed.has(mailbox));
      },
    });
    void client.invalidateQueries({ queryKey: ["search"] });
    void client.invalidateQueries({ queryKey: keys.counts() });
  };

  const changed = (mailboxId: string, threadIds: readonly string[]) => {
    mailboxes.add(mailboxId);
    for (const id of threadIds) threads.add(id);
    timer ??= setTimeout(flush, COALESCE_EVENTS_MS);
  };

  const onEvent = (event: RealtimeEvent) => {
    switch (event.type) {
      case "changed":
      case "thread.changed":
        return changed(event.mailboxId, event.threadIds);
      case "note.created":
      case "sla.at_risk":
      case "sla.breached":
        return changed(event.mailboxId, [event.threadId]);
      case "merged":
        return changed(event.mailboxId, [event.intoThreadId, ...event.fromThreadIds]);
      case "action":
        if (event.status === "failed") refetchAfterMissedEvents(client);
        return;
      case "crm.changed":
        if (event.kind === "contract") {
          void client.invalidateQueries({ queryKey: keys.driveAll() });
        }
        return void client.invalidateQueries({ queryKey: keys.crmAll() });
      case "storage.changed":
        return void client.invalidateQueries({ queryKey: keys.driveAll() });
    }
  };

  return { onEvent, stop: () => clearTimeout(timer) };
}

function openWhileInForeground(client: QueryClient, orgId: string) {
  const events = invalidateOnEvents(client);
  let socket: Realtime | undefined;
  let generation = 0;

  const open = async (resumed: boolean) => {
    const mine = ++generation;
    const cookie = Platform.OS === "web" ? null : await auth.getCookie();
    if (mine !== generation) return;
    socket = connectRealtime({
      baseUrl: config.apiUrl,
      orgId,
      openSocket: cookie
        ? (url) =>
            new NativeWebSocket(url, null, {
              headers: { cookie, origin: new URL(config.apiUrl).origin },
            })
        : undefined,
      onEvent: events.onEvent,
      onStatus: (status, { reconnected }) => {
        if (status === "open" && (reconnected || resumed)) refetchAfterMissedEvents(client);
      },
    });
  };

  const close = () => {
    generation += 1;
    socket?.close();
    socket = undefined;
  };

  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "background") return close();
    if (state !== "active") return;
    if (socket) return socket.wake();
    void open(true);
  });
  if (AppState.currentState !== "background") void open(false);

  return () => {
    subscription.remove();
    close();
    events.stop();
  };
}

/**
 * Hears the workspace's realtime events and refetches what they changed: mail lists, threads and
 * counts, Drive folders, CRM records. Reconnects when the workspace or the person changes; closes
 * when signed out (`orgId` undefined). Mount once, in the signed-in layout.
 */
export function useRealtime(orgId: string | undefined, userId: string | undefined) {
  const client = useQueryClient();
  useEffect(() => {
    if (!orgId || !userId) return;
    return openWhileInForeground(client, orgId);
  }, [client, orgId, userId]);
}
