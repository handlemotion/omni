import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { realtimeStatus, startRealtime } from "../lib/realtime.ts";

/**
 * Keeps the realtime socket open while mounted. The signed-in layout calls it once with the
 * member id: a new member (organization or account switch) closes the old socket and opens one
 * on the new organization's channel.
 */
export function useRealtimeConnection(memberId: string) {
  const client = useQueryClient();
  useEffect(() => startRealtime(client), [client, memberId]);
}

/** `connecting`, `open` or `closed`: for a "reconnecting…" indicator. */
export function useRealtimeStatus() {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, realtimeStatus.get);
}
