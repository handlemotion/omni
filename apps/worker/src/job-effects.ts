// What the Worker's background jobs share in Effect (ADR 0038 decision 2): failures typed as
// retryable or permanent, one bounded in-invocation retry, a time limit, and the per-run database
// client as a scoped resource. The work itself stays plain async functions, wrapped here at the
// edge (ADR 0009); longer waits belong to Queues and the next cron run.
import type { Db } from "@omni/db";
import { Data, type Duration, Effect, Schedule, type Scope } from "effect";
import { openDb } from "./db.ts";

/** May succeed if tried again unchanged: a network or Hyperdrive blip, a timeout, a 429 or 5xx. */
export class Retryable extends Data.TaggedError("Retryable")<{ step: string; cause: unknown }> {}

/** Fails the same way every time: bad data (SQLSTATE class 22), or a 4xx about the request. */
export class Permanent extends Data.TaggedError("Permanent")<{ step: string; cause: unknown }> {}

export type JobError = Retryable | Permanent;

/**
 * HTTP statuses that say the request itself is wrong. Not 401/403 (a key the operator fixes),
 * 408, 409 or 429: the same request may pass later.
 */
const PERMANENT_STATUSES = new Set([400, 402, 404, 405, 410, 413, 415, 422]);

/** How many `cause` links to follow: Drizzle wraps the driver's error in a `DrizzleQueryError`. */
const CAUSE_DEPTH = 5;

function isPermanent(cause: unknown): boolean {
  let error = cause;
  for (let depth = 0; depth < CAUSE_DEPTH && error && typeof error === "object"; depth++) {
    const { name, code, status, statusCode } = error as Record<string, unknown>;
    // Class 22 is a data exception (a malformed id, a value out of range): no retry fixes it.
    // Anything else from Postgres (a lost connection, a deadlock, a failover) may pass next time.
    if (name === "PostgresError" && typeof code === "string") return code.startsWith("22");
    // Anthropic and TypeSafe errors carry `status`; Stripe's carry `statusCode`.
    const http = typeof status === "number" ? status : statusCode;
    if (typeof http === "number") return PERMANENT_STATUSES.has(http);
    error = (error as { cause?: unknown }).cause;
  }
  // Unknown failures, bugs included, are retried as before: Queues and the next run bound them.
  return false;
}

export function classify(step: string, cause: unknown): JobError {
  return isPermanent(cause) ? new Permanent({ step, cause }) : new Retryable({ step, cause });
}

/** One step of a job: a plain async function whose failure is classified. */
export function attempt<A>(step: string, run: () => Promise<A>): Effect.Effect<A, JobError> {
  return Effect.tryPromise({ try: run, catch: (cause) => classify(step, cause) });
}

/**
 * A retryable failure is tried twice more in this invocation, about 250 ms and 500 ms later
 * (jittered): enough to ride out a blip, well inside a Worker's limits.
 */
export function retryTransient<A, R>(self: Effect.Effect<A, JobError, R>) {
  return self.pipe(
    Effect.retry({
      schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered),
      times: 2,
      while: (error) => error instanceof Retryable,
    }),
  );
}

/** `attempt`, with a retryable failure retried in this invocation (`retryTransient`). */
export function retried<A>(step: string, run: () => Promise<A>): Effect.Effect<A, JobError> {
  return retryTransient(attempt(step, run));
}

/**
 * Fails with `Retryable` when `self` runs past `limit`. The promise underneath is abandoned, not
 * cancelled; the run's database client closes when the run ends.
 */
export function within(step: string, limit: Duration.Input) {
  return <A, R>(self: Effect.Effect<A, JobError, R>): Effect.Effect<A, JobError, R> =>
    self.pipe(
      Effect.timeout(limit),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(new Retryable({ step, cause }))),
    );
}

/**
 * Runs a job at the Worker's edge, closing what it acquired. A failure rejects with the error
 * that caused it, as the job's promise did before, so callers and Cloudflare see the same error.
 */
export function runJob<A>(job: Effect.Effect<A, JobError, Scope.Scope>): Promise<A> {
  return Effect.runPromise(
    job.pipe(
      Effect.scoped,
      Effect.mapError((failure) => failure.cause),
    ),
  );
}

/**
 * The run's Postgres client (`db.ts`), closed however the run ends: success, failure, defect or
 * interruption. A failed close is ignored: the pool belongs to this invocation alone.
 */
export function scopedDb(env: Env, max?: number): Effect.Effect<Db, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => openDb(env, max)),
    ({ close }) => Effect.tryPromise(() => close()).pipe(Effect.ignore),
  ).pipe(Effect.map(({ db }) => db));
}
