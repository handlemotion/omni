import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { PAID_STATUSES } from "../billing.ts";
import type { Db } from "../client.ts";
import { organizations, subscriptions, users } from "../schema/auth.ts";
import { userEmails } from "../schema/identity.ts";
import {
  storageGrants,
  storageNodes,
  storageUploads,
  storageUsage,
  storageVersions,
} from "../schema/storage.ts";
import { addUsage, deleteSubtree, lockTree, lockUsage } from "./core.ts";
import { reservedBytes } from "./uploads.ts";

/** Bytes a workspace stores (trashed files included) and has reserved for uploads in progress. */
export async function storageUsageOf(db: Db, orgId: string) {
  const [row] = await db
    .select({ bytes: storageUsage.bytes })
    .from(storageUsage)
    .where(eq(storageUsage.orgId, orgId));
  return { bytes: row?.bytes ?? 0, reservedBytes: await reservedBytes(db, orgId) };
}

function inGoodStanding(db: Db, orgId: AnyColumn) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(subscriptions)
      .where(and(eq(subscriptions.orgId, orgId), inArray(subscriptions.status, PAID_STATUSES))),
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
 * Deletes the versions replaced before `before`, and the autosaves superseded before
 * `supersededBefore`, rows first, and subtracts their bytes. Returns the objects the caller must now delete, and whether more is waiting. Each
 * version goes in its own transaction, and one restored meanwhile is no longer there to delete.
 * `keepReadOnly` is as for `purgeStorageTrash`: nothing is deleted for not paying.
 */
export async function purgeStorageVersions(
  db: Db,
  options: { before: Date; supersededBefore?: Date; limit?: number; keepReadOnly?: boolean },
) {
  const limit = options.limit ?? 100;
  const isDue = or(
    lt(storageVersions.replacedAt, options.before),
    options.supersededBefore
      ? lt(storageVersions.supersededAt, options.supersededBefore)
      : undefined,
  );
  const due = await db
    .select({ id: storageVersions.id, orgId: storageVersions.orgId })
    .from(storageVersions)
    .where(and(isDue, options.keepReadOnly ? inGoodStanding(db, storageVersions.orgId) : undefined))
    .orderBy(storageVersions.replacedAt)
    .limit(limit + 1);
  const r2Keys: string[] = [];
  for (const version of due.slice(0, limit)) {
    const r2Key = await db.transaction(async (tx) => {
      await lockUsage(tx, version.orgId);
      const [gone] = await tx
        .delete(storageVersions)
        .where(and(eq(storageVersions.id, version.id), isDue))
        .returning({ size: storageVersions.size, r2Key: storageVersions.r2Key });
      if (!gone) return null;
      await addUsage(tx, version.orgId, -gone.size);
      return gone.r2Key;
    });
    if (r2Key) r2Keys.push(r2Key);
  }
  return { r2Keys, more: due.length > limit };
}

async function recomputeOne(db: Db, orgId: string) {
  return db.transaction(async (tx) => {
    const before = await lockUsage(tx, orgId);
    const [row] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${storageNodes.size}), 0)` })
      .from(storageNodes)
      .where(eq(storageNodes.orgId, orgId));
    const [kept] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${storageVersions.size}), 0)` })
      .from(storageVersions)
      .where(eq(storageVersions.orgId, orgId));
    const bytes = Number(row?.bytes ?? 0) + Number(kept?.bytes ?? 0);
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
 * go first; grants and locks go with their nodes. Rows only: the daily sweep deletes the objects once the
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

/** A SQL condition: the org whose id is `orgId` holds at least one file or folder. */
export function orgHoldsFiles(orgId: SQL) {
  return sql`exists (select 1 from ${storageNodes} sn where sn.org_id = ${orgId})`;
}

/**
 * The grants addressed to the user of the outer query's `users` row: to their primary address
 * once verified, or to any sign-in email they verified. For `exists`/`notExists`.
 */
export function grantsForUserRow(db: Db) {
  return db
    .select({ one: sql`1` })
    .from(storageGrants)
    .where(
      or(
        and(eq(users.emailVerified, true), eq(storageGrants.email, sql`lower(${users.email})`)),
        inArray(
          storageGrants.email,
          db
            .select({ email: sql`lower(${userEmails.email})` })
            .from(userEmails)
            .where(eq(userEmails.userId, users.id)),
        ),
      ),
    );
}
