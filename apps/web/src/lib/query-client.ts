import {
  isCancelledError,
  MutationCache,
  QueryCache,
  QueryClient,
  type Mutation,
} from "@tanstack/react-query";
import type { ThreadEffect } from "./cache.ts";
import { classify, failureMessage, reportFailure, type Failure } from "./failure.ts";
import { keys } from "./query-keys.ts";

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /**
       * Every caller of this mutation tells the person about a failure itself (its own toast,
       * an inline problem, a retry), so the default toast stays quiet.
       */
      handlesError?: boolean;
      /** What the action does to the cache until it settles (see `ThreadEffect`). */
      optimistic?: (variables: never) => ThreadEffect;
    };
  }
}

/** Shows a failed action's message: the app's error toast, one per kind at a time. */
export type ShowFailure = (message: string, failure: Failure) => void;

function shouldRetry(failureCount: number, error: unknown) {
  const { kind, retryable } = classify(error);
  return retryable && kind !== "unauthenticated" && kind !== "permission" && failureCount < 2;
}

/**
 * Realtime keeps mail current, so the stale time only bounds how long a missed event can leave
 * something old. A 401 from any call means the session ended (expired, revoked, signed out in
 * another tab): `onSessionLost` sends the user to sign in. Unexpected failures (bugs, 500s) go to
 * Sentry once. A failed mutation shows `showFailure`'s toast unless it says
 * `meta: { handlesError: true }`.
 */
export function createQueryClient(onSessionLost: () => void, showFailure: ShowFailure) {
  const settle = (error: unknown) => {
    if (isCancelledError(error)) return null;
    const failure = classify(error);
    if (failure.kind === "unauthenticated") onSessionLost();
    reportFailure(failure);
    return failure;
  };
  const onMutationError = (
    error: unknown,
    _variables: unknown,
    _result: unknown,
    mutation: Mutation<unknown, unknown, unknown>,
  ) => {
    const failure = settle(error);
    if (!failure || mutation.meta?.handlesError) return;
    const message = failureMessage(failure);
    if (message) showFailure(message, failure);
  };
  const client = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => void settle(error) }),
    mutationCache: new MutationCache({ onError: onMutationError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
    },
  });
  client.setQueryDefaults(keys.local(), { staleTime: Infinity, gcTime: Infinity });
  return client;
}
