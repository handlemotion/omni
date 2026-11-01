/** Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
}

/** Runs at most `concurrency` tasks at once; the rest wait in order. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
