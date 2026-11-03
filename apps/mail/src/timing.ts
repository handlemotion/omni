// Retry timing for the whole service. In-process retries run on Effect `Schedule`s built here; the
// outbox's between-attempt delay is persisted in Postgres (`retryAt`), so it uses the same formula
// through `backoffDelay` instead of sleeping.
import { Duration, Effect, Random, Schedule } from "effect";

/** Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^attempt)). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /**
   * Added to every delay, so a delay is never zero: a burst of retries from many mailboxes after a
   * network blip still spreads out.
   */
  floorMs?: number;
}

/**
 * Retry forever with `floor + backoffDelay(n - 1, base, max)` before retry `n`: exponential, fully
 * jittered, capped. Callers add their own stop conditions (`Schedule.while`, `upTo`) or interrupt.
 */
export function backoff({ baseMs, maxMs, floorMs = 0 }: BackoffOptions) {
  return Schedule.exponential(Duration.millis(baseMs)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.map(Random.next, (random) =>
        Duration.millis(
          Math.round(floorMs + random * Math.min(maxMs, Duration.toMillis(duration))),
        ),
      ),
    ),
  );
}
