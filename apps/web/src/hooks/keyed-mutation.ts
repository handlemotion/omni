import {
  useMutation,
  type MutateOptions,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { idempotencyKey } from "../lib/api.ts";

/** `Omit` that keeps a union a union, so `isSuccess` still narrows `data`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type KeyedMutation<TData, TVars extends { key: string }, TContext> = DistributiveOmit<
  UseMutationResult<TData, Error, TVars, TContext>,
  "mutate" | "mutateAsync"
> & {
  /** Runs the action once; a new call is a new intent with a fresh idempotency key. */
  mutate: (
    variables: Omit<TVars, "key">,
    options?: MutateOptions<TData, Error, TVars, TContext>,
  ) => void;
  mutateAsync: (
    variables: Omit<TVars, "key">,
    options?: MutateOptions<TData, Error, TVars, TContext>,
  ) => Promise<TData>;
};

/**
 * `useMutation` for outbox actions: each `mutate` call mints one idempotency key, which the
 * automatic retries of that call reuse.
 */
export function useKeyedMutation<TData, TVars extends { key: string }, TContext>(
  options: UseMutationOptions<TData, Error, TVars, TContext>,
): KeyedMutation<TData, TVars, TContext> {
  const mutation = useMutation(options);
  const withKey = (variables: Omit<TVars, "key">) =>
    ({ ...variables, key: idempotencyKey() }) as TVars;
  return {
    ...(mutation as DistributiveOmit<typeof mutation, "mutate" | "mutateAsync">),
    mutate: (variables, opts) => mutation.mutate(withKey(variables), opts),
    mutateAsync: (variables, opts) => mutation.mutateAsync(withKey(variables), opts),
  };
}
