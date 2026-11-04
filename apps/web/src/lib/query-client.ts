import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, isAuthError } from "./api.ts";
import { keys } from "./query-keys.ts";

/**
 * Realtime keeps mail current, so the stale time only bounds how long a missed event can leave
 * something old. Auth errors are never retried. A 401 from any call means the session ended
 * (expired, revoked, signed out in another tab): `onSessionLost` sends the user to sign in.
 */
export function createQueryClient(onSessionLost: () => void) {
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSessionLost();
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: (failureCount, error) => !isAuthError(error) && failureCount < 2,
        refetchOnWindowFocus: true,
      },
    },
  });
  // Client-only state (pending sends, failures) is never fetched and must not expire unseen.
  client.setQueryDefaults(keys.local(), { staleTime: Infinity, gcTime: Infinity });
  return client;
}
