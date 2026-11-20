import { ApiError } from "./api.ts";

/**
 * A budget of requests in flight, shared by every upload in the tab: files that upload at once
 * split it between them instead of each opening its own, so many files never flood the
 * connection or the Worker.
 */
export class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }

  /** Runs `task` once a slot is free, and frees it when `task` settles. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal) {
    await this.#take(signal);
    try {
      return await task();
    } finally {
      this.#give();
    }
  }

  #take(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener("abort", quit);
        resolve();
      };
      const quit = () => {
        const at = this.#waiting.indexOf(turn);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(signal?.reason ?? new DOMException("upload cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", quit, { once: true });
      this.#waiting.push(turn);
    });
  }

  #give() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

const BASE_MS = 500;
const CAP_MS = 30_000;

/**
 * How long to wait before try `attempt` (1 for the first retry): full jitter over an exponential
 * ceiling, so many parts that failed together don't come back together. A `Retry-After` the
 * server sent is a floor.
 */
export function backoffMs(attempt: number, retryAfterSeconds?: number) {
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  const jitter = Math.random() * ceiling;
  return Math.max(jitter, (retryAfterSeconds ?? 0) * 1000);
}

/** Whether a request that failed this way may work if sent again, unchanged. */
export function isTransient(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

/** A failure that never reached the server: the browser is offline or the connection dropped. */
export const isUnreached = (error: unknown) => error instanceof ApiError && error.status === 0;

const retryAfterOf = (error: unknown) => {
  const seconds = Number((error as { details?: { retryAfter?: unknown } }).details?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", quit);
      resolve();
    }
    function quit() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("upload cancelled", "AbortError"));
    }
    signal?.addEventListener("abort", quit, { once: true });
  });
}

/** Resolves once the browser says it is online again (at once if it already is). */
export function online(signal?: AbortSignal) {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const back = () => {
      signal?.removeEventListener("abort", quit);
      resolve();
    };
    const quit = () => {
      window.removeEventListener("online", back);
      reject(signal?.reason ?? new DOMException("upload cancelled", "AbortError"));
    };
    window.addEventListener("online", back, { once: true });
    signal?.addEventListener("abort", quit, { once: true });
  });
}

/**
 * Runs `send` until it succeeds, a failure is not `transient`, or `tries` transient failures in
 * a row. Time spent offline doesn't count as a try: it waits for the browser to come back.
 */
export async function withRetry<T>(
  send: () => Promise<T>,
  options: {
    signal: AbortSignal;
    tries: number;
    transient?: (error: unknown) => boolean;
    onRetry?: () => void;
  },
) {
  const transient = options.transient ?? isTransient;
  for (let attempt = 1; ; attempt++) {
    await online(options.signal);
    try {
      return await send();
    } catch (error) {
      if (!transient(error)) throw error;
      options.onRetry?.();
      if (isUnreached(error) && typeof navigator !== "undefined" && !navigator.onLine) {
        attempt -= 1;
        continue;
      }
      if (attempt >= options.tries) throw error;
      await sleep(backoffMs(attempt, retryAfterOf(error)), options.signal);
    }
  }
}
