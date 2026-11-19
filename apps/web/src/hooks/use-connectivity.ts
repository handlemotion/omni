import { onlineManager, useIsMutating } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { retryNow } from "../lib/connectivity.ts";

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

/** Asks the API now, for a Try again button: `pending` while the check runs. */
export function useRetryNow() {
  const [pending, setPending] = useState(false);
  return {
    pending,
    run: () => {
      setPending(true);
      void retryNow().finally(() => setPending(false));
    },
  };
}
