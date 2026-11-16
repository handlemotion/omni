// Storage's background work (ADR 0034 decisions 1 and 5). Every job is safe to run twice and
// bounded per run: what one run leaves, the next takes.
import {
  deletedStorageWorkspaces,
  expiredStorageUploads,
  purgeStorageTrash,
  recomputeStorageUsage,
  removeStorageUpload,
  STORAGE_TRASH_DAYS,
  type Db,
} from "@omni/db";
import { openDb } from "./db.ts";
import { createLogger, type Logger } from "./log.ts";
import { abortMultipart, deleteStorageObjects } from "./storage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Batches of 100 trashed nodes one daily run purges. */
const PURGE_BATCHES = 20;
/** Pages of 1000 workspace prefixes one sweep reads, and batches of 1000 objects it deletes. */
const SWEEP_PREFIX_PAGES = 10;
const SWEEP_DELETE_BATCHES = 20;
const ORG_PREFIX = "orgs/";

/**
 * The every-minute job: uploads nobody completed in 24 hours are aborted in the bucket, then
 * their rows removed, which gives back the room they held.
 */
export async function abortExpiredStorageUploads(env: Env) {
  const { db, close } = openDb(env);
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  try {
    const expired = await expiredStorageUploads(db);
    for (const upload of expired) {
      await abortMultipart(env.STORAGE_BUCKET, upload.r2Key, upload.r2UploadId);
      await removeStorageUpload(db, upload.id);
    }
    if (expired.length) log.info("storage.uploads_expired", { count: expired.length });
  } finally {
    await close();
  }
}

/** Trash older than 30 days: rows first (which frees the bytes), then the objects. */
async function purgeTrash(db: Db, bucket: R2Bucket, log: Logger, now: Date) {
  const before = new Date(now.getTime() - STORAGE_TRASH_DAYS * DAY_MS);
  let objects = 0;
  for (let batch = 0; batch < PURGE_BATCHES; batch++) {
    const { r2Keys, more } = await purgeStorageTrash(db, { before });
    await deleteStorageObjects(bucket, r2Keys, log);
    objects += r2Keys.length;
    if (!more) break;
  }
  return objects;
}

/**
 * Deletes the objects of workspaces that no longer exist. A deleted workspace's rows went by
 * cascade; its files are still under `orgs/<orgId>/`. Reads the workspace ids off the bucket's
 * own prefixes and deletes only under those with no organization row, so a live workspace's
 * objects are never touched. Starts over each run: what it deleted is no longer listed.
 */
export async function sweepDeletedWorkspaces(db: Db, bucket: R2Bucket) {
  let workspaces = 0;
  let objects = 0;
  let batches = 0;
  let cursor: string | undefined;
  for (let page = 0; page < SWEEP_PREFIX_PAGES; page++) {
    const listed = await bucket.list({ prefix: ORG_PREFIX, delimiter: "/", cursor });
    const orgIds = listed.delimitedPrefixes
      .map((prefix) => prefix.slice(ORG_PREFIX.length, -1))
      .filter((id) => id.length > 0);
    for (const orgId of await deletedStorageWorkspaces(db, orgIds)) {
      workspaces++;
      for (let more = true; more;) {
        if (batches++ >= SWEEP_DELETE_BATCHES) return { workspaces, objects, more: true };
        const under = await bucket.list({ prefix: `${ORG_PREFIX}${orgId}/`, limit: 1000 });
        if (under.objects.length) await bucket.delete(under.objects.map((object) => object.key));
        objects += under.objects.length;
        more = under.truncated;
      }
    }
    if (!listed.truncated) return { workspaces, objects, more: false };
    cursor = listed.cursor;
  }
  return { workspaces, objects, more: true };
}

/**
 * The daily job: purge old Trash, recount every workspace's usage from its files (a drifted
 * counter is wrong for a day at most), and sweep deleted workspaces out of the bucket. Each
 * step runs even if another fails; the run still fails so the error is visible.
 */
export async function storageDaily(env: Env, now = new Date()) {
  const { db, close } = openDb(env);
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  const bucket = env.STORAGE_BUCKET;
  try {
    const [purged, recounted, swept] = await Promise.allSettled([
      purgeTrash(db, bucket, log, now),
      recomputeStorageUsage(db),
      sweepDeletedWorkspaces(db, bucket),
    ]);
    log.info("storage.daily", {
      purgedObjects: purged.status === "fulfilled" ? purged.value : null,
      usageRepaired: recounted.status === "fulfilled" ? recounted.value : null,
      swept: swept.status === "fulfilled" ? swept.value : null,
    });
    const failed = [purged, recounted, swept].find((step) => step.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    await close();
  }
}
