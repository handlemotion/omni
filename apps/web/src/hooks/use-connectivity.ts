import { onlineManager, useIsMutating } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * `online`: the API can be reached (see `lib/connectivity.ts`). `queued`: actions and sends made
 * while offline, waiting to go out, in order, once it is back.
 */
export function useConnectivity() {
  const online = useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
  const queued = useIsMutating({ predicate: (mutation) => mutation.state.isPaused });
  return { online, queued };
}
