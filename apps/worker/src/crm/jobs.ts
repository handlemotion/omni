// The CRM's background work in the Worker (ADR 0035 decision 3), run at the edge in Effect (ADR
// 0038 decision 2) with the shared helpers in `job-effects.ts`. Safe to run twice and bounded per
// run; what one run leaves, the next takes.
import { crmMembersOf, endExpiredContracts, type Db, type EndedContract } from "@omni/db";
import { Effect } from "effect";
import { retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";

/** Batches of `CONTRACT_EXPIRY_BATCH` contracts one daily run ends at most. */
const EXPIRY_MAX_BATCHES = 20;

/**
 * Ends every signed contract whose `expires_on` is before today, UTC (ADR 0039 decision 4).
 * Batches until one finds nothing more or `EXPIRY_MAX_BATCHES` ran; each batch is retried on a
 * blip, and a contract a batch already ended is not ended again. `now` is for tests.
 */
export function endContracts(db: Db, log: Logger, now?: Date) {
  return Effect.gen(function* () {
    const ended: EndedContract[] = [];
    for (let batch = 0; batch < EXPIRY_MAX_BATCHES; batch++) {
      const run = yield* retried("end_contracts", () => endExpiredContracts(db, { now }));
      ended.push(...run.ended);
      if (!run.more) break;
    }
    if (ended.length > 0) log.info("crm.contracts_ended", { count: ended.length });
    return ended;
  });
}

/**
 * Tells each affected workspace's members which contracts ended (`crm.changed`, kind
 * `contract`), as a member's change is announced. The audience is read now. A socket that is down
 * never fails the job: the contracts have ended either way, and the next read shows it.
 */
function announceEnded(env: Env, db: Db, log: Logger, ended: EndedContract[]) {
  const byOrg = Map.groupBy(ended, (contract) => contract.orgId);
  return Effect.forEach(
    byOrg,
    ([orgId, contracts]) =>
      Effect.tryPromise(async () => {
        const memberIds = await crmMembersOf(db, orgId);
        if (memberIds.length === 0) return;
        const stub = env.REALTIME.get(env.REALTIME.idFromName(orgId));
        await stub.broadcast(memberIds, {
          type: "crm.changed",
          kind: "contract",
          ids: contracts.map((contract) => contract.contractId),
        });
      }).pipe(
        Effect.catch((error) => Effect.sync(() => log.warn("crm.announce_failed", { error }))),
      ),
    { concurrency: 1, discard: true },
  );
}

/** The CRM's daily work: contracts past their end date end. */
export function crmDaily(env: Env) {
  const log = createLogger({ component: "crm", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const ended = yield* endContracts(db, log);
      yield* announceEnded(env, db, log, ended);
      return { ended: ended.length };
    }),
  );
}
