import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { realtimeStatus, startRealtime } from "../lib/realtime.ts";
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
  // A string, so a refetch that returns the same workspaces keeps the sockets.
  const orgIds = (options.everyWorkspace && workspaces?.map((w) => w.id).join(",")) || "";
  useEffect(
    () => startRealtime(client, orgIds ? orgIds.split(",") : [], orgId),
    [client, orgId, options.memberId, orgIds],
  );
}

/** `connecting`, `open` or `closed`: for a "reconnecting…" indicator. */
export function useRealtimeStatus() {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, realtimeStatus.get);
}
