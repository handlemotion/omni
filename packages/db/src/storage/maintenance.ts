// Trusted background work for Storage (ADR 0034 decisions 5 and 7): the purge of old Trash, and
// the usage counter's read and its daily repair. Callers have already resolved the workspace.
import { and, eq, exists, inArray, isNotNull, lt, not, or, sql } from "drizzle-orm";
import { PAID_STATUSES } from "../billing.ts";
import type { Db } from "../client.ts";
import { isCompany } from "../personal-space.ts";
import { organizations, subscriptions } from "../schema/auth.ts";
import { storageNodes, storageUploads, storageUsage } from "../schema/storage.ts";
import { deleteSubtree, lockTree, lockUsage } from "./core.ts";
import { reservedBytes } from "./uploads.ts";

/** Bytes a workspace stores (trashed files included) and has reserved for uploads in progress. */
export async function storageUsageOf(db: Db, orgId: string) {
  const [row] = await db
    .select({ bytes: storageUsage.bytes })
    .from(storageUsage)
    .where(eq(storageUsage.orgId, orgId));
  return { bytes: row?.bytes ?? 0, reservedBytes: await reservedBytes(db, orgId) };
}

/** SQL condition: the workspace in `orgId` may write, as ADR 0015 defines good standing. */
function inGoodStanding(db: Db, orgId: typeof storageNodes.orgId) {
  return or(
    // A Personal space is free (ADR 0024).
    not(isCompany(db, orgId)),
    exists(
      db
        .select({ one: sql`1` })
        .from(subscriptions)
        .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, PAID_STATUSES))),
    ),
  );
}

/**
 * Deletes what was trashed before `before`, rows first, and subtracts its bytes. Returns the
 * objects the caller must now delete, and whether more is waiting. Each trashed node goes in
 * its own transaction, so a run that stops halfway has still freed what it returned.
 *
 * `keepReadOnly` (the caller sets it where billing is on) leaves the Trash of a workspace with
 * no plan in good standing alone: restoring is a write it cannot make, and nothing is deleted
 * for not paying. Its 30 days are not extended: what is due goes with the first purge after it
 * pays again.
 */
export async function purgeStorageTrash(
  db: Db,
  options: { before: Date; limit?: number; keepReadOnly?: boolean },
) {
  const limit = options.limit ?? 100;
  const due = await db
    .select({ id: storageNodes.id, orgId: storageNodes.orgId })
    .from(storageNodes)
    .where(
      and(
        isNotNull(storageNodes.trashedAt),
        lt(storageNodes.trashedAt, options.before),
        options.keepReadOnly ? inGoodStanding(db, storageNodes.orgId) : undefined,
      ),
    )
    .orderBy(storageNodes.trashedAt)
    .limit(limit + 1);
  const r2Keys: string[] = [];
  for (const node of due.slice(0, limit)) {
    const deleted = await db.transaction(async (tx) => {
      await lockTree(tx, node.orgId);
      // Still there and still due: it may have been restored (and trashed again, which starts
      // its 30 days over), or gone with its folder.
      const [still] = await tx
        .select({ id: storageNodes.id })
        .from(storageNodes)
        .where(and(eq(storageNodes.id, node.id), lt(storageNodes.trashedAt, options.before)));
      return still ? deleteSubtree(tx, node.orgId, node.id) : null;
    });
    if (deleted) r2Keys.push(...deleted.r2Keys);
  }
  return { r2Keys, more: due.length > limit };
}

/**
 * Sets a workspace's usage to what its nodes add up to, and returns whether it had drifted. The
 * usage row is locked first, as every change to a file's bytes does, so nothing lands between
 * the sum and the write.
 */
async function recomputeOne(db: Db, orgId: string) {
  return db.transaction(async (tx) => {
    const before = await lockUsage(tx, orgId);
    const [row] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${storageNodes.size}), 0)` })
      .from(storageNodes)
      .where(eq(storageNodes.orgId, orgId));
    const bytes = Number(row?.bytes ?? 0);
    if (bytes === before) return false;
    await tx.update(storageUsage).set({ bytes }).where(eq(storageUsage.orgId, orgId));
    return true;
  });
}

/**
 * Recomputes `storage_usage` from `storage_nodes`, for one workspace or for every workspace
 * that has a node or a usage row. Returns how many counters were wrong.
 */
export async function recomputeStorageUsage(db: Db, orgId?: string) {
  const orgIds = orgId
    ? [orgId]
    : (
        (await db.execute(
          sql`select org_id from ${storageUsage} union select org_id from ${storageNodes}`,
        )) as unknown as { org_id: string }[]
      ).map((row) => row.org_id);
  let repaired = 0;
  for (const id of orgIds) {
    if (await recomputeOne(db, id)) repaired++;
  }
  return repaired;
}

/**
 * For the bucket sweep: which of `orgIds` (read off object keys) name no workspace any more.
 * An id only ever reaches a key from a workspace that existed, and ids are never reused, so one
 * with no row is a deleted workspace whose objects nothing can reach.
 */
export async function deletedStorageWorkspaces(db: Db, orgIds: string[]) {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.id, orgIds));
  const alive = new Set(rows.map((row) => row.id));
  return orgIds.filter((id) => !alive.has(id));
}

/**
 * For the bucket sweep: one workspace id picked at random, or null when there is none. The sweep
 * starts its listing there, so over many runs it starts everywhere.
 */
export async function randomStorageSweepStart(db: Db) {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(sql`random()`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Removes a workspace's storage rows ahead of the workspace itself. Trusted: the caller has
 * decided the workspace is being deleted. Its members are deleted before it is, and a member who
 * still owns files cannot go (`storage_nodes.owner_member_id` has no cascade), so the files' rows
 * go first; grants go with their nodes. Rows only: the daily sweep deletes the objects once the
 * organization row is gone. Run again it finds nothing.
 */
export async function deleteWorkspaceStorage(db: Db, orgId: string) {
  await db.transaction(async (tx) => {
    await lockTree(tx, orgId);
    await lockUsage(tx, orgId);
    await tx.delete(storageUploads).where(eq(storageUploads.orgId, orgId));
    await tx.delete(storageNodes).where(eq(storageNodes.orgId, orgId));
    await tx.delete(storageUsage).where(eq(storageUsage.orgId, orgId));
  });
}
