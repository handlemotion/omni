// Desktop notifications from every workspace the user is in, not only the one on screen: one
// watch socket per workspace (`/api/realtime?watch=1`) hears its new mail (`mail.arrived`) and
// the member's notifications there. A watch socket never counts as an open app, so the phone
// still gets its push. Everything is fetched the usual way, naming the workspace.
import { connectRealtime, WORKSPACE_HEADER, type RealtimeEvent } from "@omni/client";
import type { QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { onWake } from "./connectivity.ts";
import {
  claimThread,
  createNotifier,
  shouldShow,
  showNotification,
} from "./desktop-notifications.ts";
import { threadQuery } from "./mail-queries.ts";
import { NOTIFICATION_PAGE_SIZE } from "./notifications.ts";

/** What a click opens: a thread, the workspace's inbox, or its notifications (`panel`). */
export type WatchTarget = { orgId: string; threadId?: string; panel?: boolean };

/** More new threads than this in one go (a burst, a catch-up) are one "N new messages". */
const ONE_BY_ONE = 3;

export interface WatchOptions {
  /** The workspace's name, for a notification that sums up a burst. */
  nameOf: (orgId: string) => string | undefined;
  open: (target: WatchTarget) => void;
}

/** Keeps a watch socket open for each of `orgIds` until the returned stop is called. */
export function watchWorkspaces(
  client: QueryClient,
  orgIds: readonly string[],
  options: WatchOptions,
) {
  const stops = orgIds.map((orgId) => watchWorkspace(client, orgId, options));
  return () => {
    for (const stop of stops) stop();
  };
}

function watchWorkspace(client: QueryClient, orgId: string, options: WatchOptions) {
  const notify = createNotifier(orgId, (notice) =>
    options.open(notice.threadId ? { orgId, threadId: notice.threadId } : { orgId, panel: true }),
  );
  // The unread list, first as the baseline, then again for each new one (and after a drop,
  // since a notification may have come while no socket listened).
  const readNotifications = () =>
    call(
      api.notifications.$get(
        { query: { unread: "true", limit: String(NOTIFICATION_PAGE_SIZE) } },
        { headers: { [WORKSPACE_HEADER]: orgId } },
      ),
    )
      .then((page) => notify(page.notifications))
      .catch((error: unknown) => console.warn("notifications: could not read", orgId, error));

  const onEvent = (event: RealtimeEvent) => {
    if (event.type === "notification") void readNotifications();
    else if (event.type === "mail.arrived")
      void announceMail(client, orgId, event.threadIds, options);
  };
  const socket = connectRealtime({
    baseUrl: window.location.origin,
    orgId,
    watch: true,
    onEvent,
    onStatus: (status) => {
      if (status === "open") void readNotifications();
    },
  });
  const stopWaking = onWake(() => socket.wake());
  return () => {
    stopWaking();
    socket.close();
  };
}

/** Shows new mail in `threadIds`: who wrote and the subject, or a count for a burst. */
async function announceMail(
  client: QueryClient,
  orgId: string,
  threadIds: readonly string[],
  options: WatchOptions,
) {
  if (!shouldShow(orgId)) return;
  if (threadIds.length > ONE_BY_ONE) {
    // Claimed, so a "customer replied" in the same burst doesn't show again on its own.
    const fresh = threadIds.filter((threadId) => claimThread(threadId));
    if (fresh.length === 0) return;
    showNotification(
      {
        tag: `mail:${orgId}:${fresh.join(",")}`,
        title: options.nameOf(orgId) ?? "Omni",
        body: fresh.length === 1 ? "1 new message" : `${fresh.length} new messages`,
      },
      () => options.open({ orgId }),
    );
    return;
  }
  for (const threadId of threadIds) {
    // Read now (a thread read moments ago is cached as read), and cached as the reader's own
    // query, so opening it from the notification is instant.
    const thread = await client
      .fetchQuery({ ...threadQuery(threadId), staleTime: 0 })
      .catch(() => undefined);
    const latest = thread?.messages.at(-1);
    if (!thread || !latest || thread.read || latest.fromTeam || latest.automated) continue;
    if (!claimThread(threadId)) continue;
    showNotification(
      {
        tag: `mail:${latest.id}`,
        title: latest.fromName || latest.fromAddress,
        body: latest.subject || "(no subject)",
      },
      () => options.open({ orgId, threadId }),
    );
  }
}
