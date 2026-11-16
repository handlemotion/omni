// Storage's background work (ADR 0034 decisions 1 and 5). Every job is safe to run twice and
// bounded per run: what one run leaves, the next takes. Each is an Effect program run at the
// edge (ADR 0038 decision 2): every database and bucket call is retried on a blip, and the run's
// Postgres client is a scoped resource.
import {
  deletedStorageWorkspaces,
  expiredStorageUploads,
  purgeStorageTrash,
  randomStorageSweepStart,
  recomputeStorageUsage,
  removeStorageUpload,
  STORAGE_TOMBSTONE_DAYS,
  STORAGE_TRASH_DAYS,
  sweepStorageTombstones,
  type Db,
} from "@omni/db";
import { Effect, Result } from "effect";
import { loadConfig } from "../env.ts";
import { type JobError, retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";
import { abortMultipart, deleteStorageObjects } from "./core.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Batches of 100 trashed nodes one daily run purges. */
const PURGE_BATCHES = 20;
/** Batches of 1000 tombstones one daily run sweeps. */
const TOMBSTONE_BATCHES = 20;
/** Pages of 1000 workspace prefixes one sweep reads, and batches of 1000 objects it deletes. */
const SWEEP_PREFIX_PAGES = 10;
const SWEEP_DELETE_BATCHES = 20;
const ORG_PREFIX = "orgs/";
/** A page with this many workspaces, most of them unknown to the database, stops the sweep. */
const SWEEP_GUARD_PREFIXES = 20;

/**
 * The every-minute job: uploads nobody completed in 24 hours are aborted in the bucket, then
 * their rows removed, which gives back the room they held. The parts may already have been
 * stitched into the object by a `complete` that never wrote the file's row: once the row is gone
 * as an upload nobody completed, no file owns that key, and the object goes too.
 */
export function abortExpiredStorageUploads(env: Env) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const expired = yield* retried("expired_uploads", () => expiredStorageUploads(db));
      // One upload at a time; one that fails is left for the next minute and fails this run.
      const failures = yield* eachIsolated(expired, (upload) =>
        retried("expire_upload", async () => {
          await abortMultipart(env.STORAGE_BUCKET, upload.r2Key, upload.r2UploadId);
          if (await removeStorageUpload(db, upload.id)) {
            await deleteStorageObjects(env.STORAGE_BUCKET, [upload.r2Key], log);
          }
        }),
      );
      if (expired.length) log.info("storage.uploads_expired", { count: expired.length });
      if (failures[0]) return yield* Effect.fail(failures[0]);
    }),
  );
}

/** Runs `job` for each item in turn; a failure never stops the rest. Answers the failures. */
function eachIsolated<T>(items: readonly T[], job: (item: T) => Effect.Effect<unknown, JobError>) {
  return Effect.forEach(items, (item) => Effect.result(job(item)), { concurrency: 1 }).pipe(
    Effect.map((results) => results.filter(Result.isFailure).map((result) => result.failure)),
  );
}

/**
 * Trash older than 30 days: rows first (which frees the bytes), then the objects. With billing
 * on, a read-only workspace keeps its Trash: nothing is deleted for not paying (ADR 0034).
 */
function purgeTrash(db: Db, bucket: R2Bucket, log: Logger, now: Date, keepReadOnly: boolean) {
  return Effect.gen(function* () {
    const before = new Date(now.getTime() - STORAGE_TRASH_DAYS * DAY_MS);
    let objects = 0;
    for (let batch = 0; batch < PURGE_BATCHES; batch++) {
      const { r2Keys, more } = yield* retried("purge_trash", () =>
        purgeStorageTrash(db, { before, keepReadOnly }),
      );
      // Never fails: objects it could not delete are logged (`storage.objects_left`).
      yield* Effect.promise(() => deleteStorageObjects(bucket, r2Keys, log));
      objects += r2Keys.length;
      if (!more) break;
    }
    return objects;
  });
}

/**
 * Tombstones older than 90 days (ADR 0043): a sync client further behind than that lists its
 * drive again, which the sweep tells it by raising the workspace's cursor floor.
 */
function sweepTombstones(db: Db, now: Date) {
  return Effect.gen(function* () {
    const before = new Date(now.getTime() - STORAGE_TOMBSTONE_DAYS * DAY_MS);
    let deleted = 0;
    for (let batch = 0; batch < TOMBSTONE_BATCHES; batch++) {
      const swept = yield* retried("sweep_tombstones", () =>
        sweepStorageTombstones(db, { before }),
      );
      deleted += swept.deleted;
      if (!swept.more) break;
    }
    return deleted;
  });
}

interface Sweep {
  workspaces: number;
  objects: number;
  /** What the run has spent of `SWEEP_PREFIX_PAGES` and `SWEEP_DELETE_BATCHES`. */
  pages: number;
  batches: number;
  /** Set when the database does not look like this bucket's: the run deletes nothing more. */
  refused?: "no_workspaces" | "mostly_unknown";
}

/** The workspace ids on one page of the bucket's prefixes. */
const workspaceIds = (listed: R2Objects) =>
  listed.delimitedPrefixes
    .map((prefix) => prefix.slice(ORG_PREFIX.length, -1))
    .filter((id) => id.length > 0);

/**
 * A few deleted workspaces among many are what the sweep is for. Most of a page being unknown
 * is a database that is not this bucket's (a second install on the same bucket, a restore from
 * before these workspaces existed), and deleting would take live files that nothing brings back.
 */
const looksForeign = (listed: number, gone: number) =>
  listed >= SWEEP_GUARD_PREFIXES && gone * 2 > listed;

/** Deletes everything under a deleted workspace's prefix. False when the run's batches ran out. */
function deleteWorkspaceObjects(bucket: R2Bucket, orgId: string, sweep: Sweep) {
  return Effect.gen(function* () {
    for (let more = true; more;) {
      if (sweep.batches++ >= SWEEP_DELETE_BATCHES) return false;
      const under = yield* retried("list_objects", () =>
        bucket.list({ prefix: `${ORG_PREFIX}${orgId}/`, limit: 1000 }),
      );
      const keys = under.objects.map((object) => object.key);
      if (keys.length) yield* retried("delete_objects", () => bucket.delete(keys));
      sweep.objects += keys.length;
      more = under.truncated;
    }
    return true;
  });
}

/**
 * Sweeps one stretch of the workspace prefixes, in key order: from just after the key `after`
 * (the first prefix when absent) until the listing ends or has passed the key `until`. False
 * when the run's pages or batches ran out first.
 */
function sweepStretch(
  db: Db,
  bucket: R2Bucket,
  sweep: Sweep,
  stretch: { after?: string; until?: string },
) {
  const { after, until } = stretch;
  return Effect.gen(function* () {
    let cursor: string | undefined;
    for (;;) {
      if (sweep.pages++ >= SWEEP_PREFIX_PAGES) return false;
      const listed = yield* retried("list_prefixes", () =>
        bucket.list({
          prefix: ORG_PREFIX,
          delimiter: "/",
          // A cursor already says where to go on from.
          ...(cursor ? { cursor } : after ? { startAfter: after } : {}),
        }),
      );
      const orgIds = workspaceIds(listed);
      const gone = yield* retried("deleted_workspaces", () => deletedStorageWorkspaces(db, orgIds));
      if (looksForeign(orgIds.length, gone.length)) {
        sweep.refused = "mostly_unknown";
        return false;
      }
      for (const orgId of gone) {
        sweep.workspaces++;
        if (!(yield* deleteWorkspaceObjects(bucket, orgId, sweep))) return false;
      }
      const passed =
        until !== undefined && listed.delimitedPrefixes.some((prefix) => prefix > until);
      if (!listed.truncated || passed) return true;
      cursor = listed.cursor;
    }
  });
}

/**
 * Deletes the objects of workspaces that no longer exist. A deleted workspace's rows went by
 * cascade; its files are still under `orgs/<orgId>/`. Reads the workspace ids off the bucket's
 * own prefixes and deletes only under those with no organization row, so a live workspace's
 * objects are never touched.
 *
 * A run reads a bounded number of pages, so it must not begin at the first prefix every time:
 * with more live workspaces than those pages hold, a deleted one sorted after them would never
 * be read. Each run starts after a workspace picked at random, reads on to the end, then wraps
 * around to the first prefix and reads up to where it started. Nothing is remembered between
 * runs: over many runs every prefix is read, and a bucket that fits in one run's pages is read
 * whole every run. Should a bucket ignore `startAfter`, the first stretch is the whole listing.
 *
 * The sweep trusts the database to say which workspaces are gone, so it refuses, deleting
 * nothing, when the database does not look like this bucket's: it holds no workspace at all, or
 * most of a page of the bucket's workspaces are unknown to it (`looksForeign`). The bucket's
 * first page is checked before anything is deleted, since a stretch that starts late may list
 * too few to tell.
 */
export function sweepDeletedWorkspaces(db: Db, bucket: R2Bucket, log: Logger) {
  return Effect.gen(function* () {
    const sweep: Sweep = { workspaces: 0, objects: 0, pages: 0, batches: 0 };
    const startId = yield* retried("sweep_start", () => randomStorageSweepStart(db));
    const first = workspaceIds(
      yield* retried("list_prefixes", () => bucket.list({ prefix: ORG_PREFIX, delimiter: "/" })),
    );
    if (!startId) {
      if (first.length > 0) sweep.refused = "no_workspaces";
    } else {
      const gone = yield* retried("deleted_workspaces", () => deletedStorageWorkspaces(db, first));
      if (looksForeign(first.length, gone.length)) sweep.refused = "mostly_unknown";
    }
    const start = `${ORG_PREFIX}${startId}/`;
    const done =
      startId !== null &&
      !sweep.refused &&
      (yield* sweepStretch(db, bucket, sweep, { after: start })) &&
      (yield* sweepStretch(db, bucket, sweep, { until: start }));
    if (sweep.refused) log.error("storage.sweep_refused", { reason: sweep.refused });
    const { workspaces, objects, refused } = sweep;
    return { workspaces, objects, more: !done && !refused && startId !== null, refused };
  });
}

/**
 * The daily job: purge old Trash, recount every workspace's usage from its files (a drifted
 * counter is wrong for a day at most), sweep deleted workspaces out of the bucket, and sweep old
 * sync tombstones. The four
 * run side by side and each runs even if another fails; the run still fails so the error is
 * visible.
 */
export function storageDaily(env: Env, now = new Date()) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  const bucket = env.STORAGE_BUCKET;
  const billed = loadConfig(env).auth.billing !== undefined;
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const [purged, recounted, swept, tombstones] = yield* Effect.all(
        [
          Effect.result(purgeTrash(db, bucket, log, now, billed)),
          Effect.result(retried("recompute_usage", () => recomputeStorageUsage(db))),
          Effect.result(sweepDeletedWorkspaces(db, bucket, log)),
          Effect.result(sweepTombstones(db, now)),
        ],
        { concurrency: "unbounded" },
      );
      log.info("storage.daily", {
        purgedObjects: valueOf(purged),
        usageRepaired: valueOf(recounted),
        swept: valueOf(swept),
        tombstonesSwept: valueOf(tombstones),
      });
      const failed =
        failureOf(purged) ?? failureOf(recounted) ?? failureOf(swept) ?? failureOf(tombstones);
      if (failed) return yield* Effect.fail(failed);
    }),
  );
}

const valueOf = <A>(step: Result.Result<A, JobError>) =>
  Result.isSuccess(step) ? step.success : null;
const failureOf = <A>(step: Result.Result<A, JobError>): JobError | undefined =>
  Result.isFailure(step) ? step.failure : undefined;
