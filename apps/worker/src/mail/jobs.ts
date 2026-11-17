// Mail's background work in the Worker (ADR 0035 decision 3), run at the edge in Effect (ADR 0038
// decision 2) with the shared helpers in `job-effects.ts`. Each job is safe to run twice and
// bounded per run; what one run leaves, the next takes.
import { indexParticipants, type Db } from "@omni/db";
import { Effect, Result } from "effect";
import { attempt, type JobError, retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";
import { helpdeskClock } from "../sla.ts";

/** Batches one run takes at most (each `PARTICIPANT_BATCH` messages, one short transaction). */
const BACKFILL_MAX_BATCHES = 20;
/** Wall time after which a run starts no new batch and leaves the rest to the next minute. */
const BACKFILL_BUDGET_MS = 20_000;

/**
 * Indexes `thread_participants` (ADR 0036 decision 4) for messages stored without them: mail
 * from before the table, or from an older mail service mid-deploy. Batches until one finds
 * nothing, `BACKFILL_MAX_BATCHES` ran or the budget is spent; each batch is retried on a blip.
 * `now` is for tests: the backfill leaves messages younger than `PARTICIPANT_SETTLE_MS` alone.
 */
export function backfillParticipants(db: Db, log: Logger, now?: Date) {
  return Effect.gen(function* () {
    const deadline = Date.now() + BACKFILL_BUDGET_MS;
    const total = { batches: 0, messages: 0, participants: 0 };
    while (total.batches < BACKFILL_MAX_BATCHES && Date.now() < deadline) {
      const batch = yield* retried("index_participants", () => indexParticipants(db, { now }));
      total.batches++;
      total.messages += batch.messages;
      total.participants += batch.participants;
      if (batch.messages === 0) break;
    }
    if (total.messages > 0) log.info("mail.participants_indexed", total);
    return total;
    // No `Effect.timeout` around this: it would abandon a batch's transaction, not stop it, and
    // the next minute's run would start beside it (ADR 0038). The budget above bounds the run.
  });
}

/**
 * Mail's every-minute work: the helpdesk's clock and the participant backfill. Each runs even if
 * the other fails; the run then fails with the first failure, so the cron shows it.
 */
export function mailMinute(env: Env) {
  const log = createLogger({ component: "mail", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const [clock, participants] = yield* Effect.all(
        [
          Effect.result(attempt("helpdesk_clock", () => helpdeskClock(env))),
          Effect.result(backfillParticipants(db, log)),
        ],
        { concurrency: "unbounded" },
      );
      const failed = failureOf(clock) ?? failureOf(participants);
      if (failed) return yield* Effect.fail(failed);
    }),
  );
}

const failureOf = <A>(step: Result.Result<A, JobError>) =>
  (Result.isFailure(step) ? step.failure : undefined) satisfies JobError | undefined;
