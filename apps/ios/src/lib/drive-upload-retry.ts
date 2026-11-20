import * as Network from "expo-network";
import { ApiError } from "./api.ts";

const TRIES = 8;
const BASE_MS = 1_000;
const CAP_MS = 30_000;
const RATE_LIMITED_MS = 5_000;

/** A failure another try may get past: no answer, a timeout, a rate limit, or the server's fault. */
export const isTransient = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);

/**
 * How long to wait before try `attempt + 1`: what a 429 asked for, else exponential backoff with
 * full jitter, so 200 files that failed together don't all come back in the same second.
 */
export function backoffMs(attempt: number, error: unknown, now = Date.now()) {
  if (error instanceof ApiError && error.status === 429) {
    const asked = error.retryAt ? error.retryAt - now : 0;
    return Math.max(asked, RATE_LIMITED_MS) + Math.random() * BASE_MS;
  }
  return Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt);
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

const offline = (state: Network.NetworkState) =>
  state.isConnected === false || state.isInternetReachable === false;

/** Resolves once the phone has a network again (at once if it has one), or rejects on abort. */
export async function waitForNetwork(signal: AbortSignal) {
  if (!offline(await Network.getNetworkStateAsync())) return;
  await new Promise<void>((resolve, reject) => {
    const subscription = Network.addNetworkStateListener((state) => {
      if (offline(state)) return;
      finish();
      resolve();
    });
    const stop = () => {
      finish();
      reject(signal.reason);
    };
    const finish = () => {
      subscription.remove();
      signal.removeEventListener("abort", stop);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Runs `attempt` until it succeeds, a failure isn't transient, or `TRIES` transient failures in a
 * row. While the phone is offline it waits for the network instead of spending tries. `onRetry`
 * runs before each wait (a part resets its progress there).
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  onRetry?: () => void,
) {
  for (let failures = 0; ;) {
    signal.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || !isTransient(error)) throw error;
      onRetry?.();
      const state = await Network.getNetworkStateAsync().catch(() => ({}) as Network.NetworkState);
      if (offline(state)) {
        await waitForNetwork(signal);
        continue;
      }
      failures += 1;
      if (failures >= TRIES) throw error;
      await sleep(backoffMs(failures, error), signal);
    }
  }
}
