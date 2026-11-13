import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { onThreadsMerged, realtimeStatus, startRealtime } from "../lib/realtime.ts";
import { useWorkspaces } from "./use-workspaces.ts";

/**
 * Keeps the realtime socket for `orgId` open while mounted. With `everyWorkspace`, also one per
 * other workspace the user belongs to: the signed-in layout's lists span them all (ADR 0014).
 * A new `memberId` or org (organization or account switch), or a joined or left workspace,
 * reopens them.
 */
export function useRealtimeConnection(
  orgId: string,
  options: { memberId?: string; everyWorkspace?: boolean } = {},
) {
  const client = useQueryClient();
  const workspaces = useWorkspaces({ enabled: !!options.everyWorkspace }).data?.workspaces;
  // A string, so a refetch that returns the same workspaces keeps the sockets. Only workspaces
  // with a mailbox: one with none (a Personal space before anything is connected, ADR 0024) has
  // nothing to announce. Connecting its first mailbox refetches the workspaces and opens it.
  const orgIds =
    (options.everyWorkspace &&
      workspaces
        ?.filter((w) => w.mailboxes.length > 0)
        .map((w) => w.id)
        .join(",")) ||
    "";
  useEffect(
    () => startRealtime(client, orgIds ? orgIds.split(",") : [], orgId),
    [client, orgId, options.memberId, orgIds],
  );
}

/** `connecting`, `open` or `closed`: for a "reconnecting…" indicator. */
export function useRealtimeStatus() {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, realtimeStatus.get);
}

/**
 * Calls `follow(intoThreadId)` when the thread `threadId` is merged into another (its messages
 * and helpdesk state moved there), so a reader showing it can move to the survivor.
 */
export function useFollowMerge(threadId: string, follow: (intoThreadId: string) => void) {
  const latest = useRef(follow);
  latest.current = follow;
  useEffect(
    () =>
      onThreadsMerged((event) => {
        if (event.fromThreadIds.includes(threadId)) latest.current(event.intoThreadId);
      }),
    [threadId],
  );
}
