import { and, asc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, organizations } from "../schema/auth.ts";
import { personalSpaces } from "../schema/identity.ts";
import {
  storageLocks,
  storageNodes,
  storageSyncState,
  storageTombstones,
} from "../schema/storage.ts";
import {
  lockJoin,
  MAX_WALK,
  nodeColumns,
  pageSize,
  toNode,
  type Drive,
  type NodeRow,
  type StorageNode,
  type StorageSpace,
} from "./core.ts";

/** Days a tombstone is kept. A client away longer lists its drives again. */
export const STORAGE_TOMBSTONE_DAYS = 90;

/**
 * Where a client is in a drive's feed: it has seen every change up to and including
 * `(revision, id)`. An empty `id` sits before every change of `revision`.
 */
export interface StorageSyncCursor {
  revision: number;
  id: string;
}

/** One entry of a drive's feed. A node in Trash, or inside a folder that is, has `inTrash`. */
export type StorageChange =
  | { id: string; revision: number; deleted: false; node: StorageNode; inTrash: boolean }
  | { id: string; revision: number; deleted: true };

export type StorageChangesResult =
  | {
      status: "ok";
      changes: StorageChange[];
      /** Pass it back for what comes next. Never null: an empty feed still moves it on. */
      nextCursor: StorageSyncCursor;
      /** More changes are waiting now; ask again with `nextCursor`. */
      more: boolean;
    }
  | { status: "not_found" }
  | { status: "cursor_expired" };

const inDrive: (
  table: typeof storageNodes | typeof storageTombstones,
  drive: Drive,
) => SQL | undefined = (table, drive) => {
  return and(
    eq(table.orgId, drive.orgId),
    eq(table.space, drive.space),
    sql`coalesce(${table.ownerMemberId}, '') = ${drive.ownerMemberId ?? ""}`,
  );
};

async function trashedOf(ex: Db, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = (await ex.execute(sql`
    with recursive up(start, parent_id, trashed, depth) as (
      select n.id, n.parent_id, n.trashed_at is not null, 0 from ${storageNodes} n
        where n.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      union all
      select up.start, p.parent_id, p.trashed_at is not null, up.depth + 1 from ${storageNodes} p
        join up on p.id = up.parent_id where not up.trashed and up.depth < ${MAX_WALK}
    ) select distinct start from up where trashed`)) as unknown as { start: string }[];
  return new Set(rows.map((row) => row.start));
}

const after = (
  table: typeof storageNodes | typeof storageTombstones,
  idColumn: typeof storageNodes.id | typeof storageTombstones.nodeId,
  cursor: StorageSyncCursor | null,
) =>
  cursor ? sql`(${table.revision}, ${idColumn}) > (${cursor.revision}, ${cursor.id})` : undefined;

const before = (a: StorageSyncCursor, b: StorageSyncCursor) =>
  a.revision < b.revision || (a.revision === b.revision && a.id < b.id);

/**
 * Changes to `drive` after `cursor`, in revision order: nodes live and in Trash, and tombstones.
 * No cursor lists the whole drive. Each node comes once, as it is now: a node changed twice
 * since the cursor shows only at its last revision.
 */
export async function listChanges(
  db: Db,
  drive: Drive,
  page: { cursor?: StorageSyncCursor | null; limit?: number },
) {
  const cursor = page.cursor ?? null;
  const limit = pageSize(page.limit);
  return db.transaction<StorageChangesResult>(
    async (tx) => {
      const [state] = await tx
        .select({ revision: storageSyncState.revision, floor: storageSyncState.cursorFloor })
        .from(storageSyncState)
        .where(eq(storageSyncState.orgId, drive.orgId));
      if (cursor && state && cursor.revision < state.floor) {
        const result: StorageChangesResult = { status: "cursor_expired" };
        return result;
      }
      const taken = await feedPage(tx, drive, cursor, limit);
      const more = taken.length > limit;
      if (more) taken.pop();
      const trashed = await trashedOf(
        tx,
        taken.flatMap((entry) => (entry.row ? [entry.id] : [])),
      );
      const changes: StorageChange[] = taken.map((entry) =>
        entry.row
          ? {
              id: entry.id,
              revision: entry.revision,
              deleted: false,
              node: toNode(entry.row),
              inTrash: trashed.has(entry.id),
            }
          : { id: entry.id, revision: entry.revision, deleted: true },
      );
      const last = taken.at(-1);
      let nextCursor: StorageSyncCursor = last
        ? { revision: last.revision, id: last.id }
        : (cursor ?? { revision: 0, id: "" });
      const settled = { revision: (state?.revision ?? 0) + 1, id: "" };
      if (!more && before(nextCursor, settled)) nextCursor = settled;
      const result: StorageChangesResult = { status: "ok", changes, nextCursor, more };
      return result;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function feedPage(tx: Db, drive: Drive, cursor: StorageSyncCursor | null, limit: number) {
  const nodes = await tx
    .select(nodeColumns)
    .from(storageNodes)
    .leftJoin(storageLocks, lockJoin)
    .where(and(inDrive(storageNodes, drive), after(storageNodes, storageNodes.id, cursor)))
    .orderBy(asc(storageNodes.revision), asc(storageNodes.id))
    .limit(limit + 1);
  const tombstones = await tx
    .select({ id: storageTombstones.nodeId, revision: storageTombstones.revision })
    .from(storageTombstones)
    .where(
      and(
        inDrive(storageTombstones, drive),
        after(storageTombstones, storageTombstones.nodeId, cursor),
      ),
    )
    .orderBy(asc(storageTombstones.revision), asc(storageTombstones.nodeId))
    .limit(limit + 1);
  return [
    ...nodes.map((row) => ({ id: row.id, revision: row.revision, row: row as NodeRow | null })),
    ...tombstones.map((row) => ({ id: row.id, revision: row.revision, row: null })),
  ]
    .toSorted((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))
    .slice(0, limit + 1);
}

/** The drive's revision: that of its latest change, 0 when it has none since sync existed. */
export async function driveRevision(ex: Db, drive: Drive) {
  const [nodes] = await ex
    .select({ revision: sql<string | null>`max(${storageNodes.revision})` })
    .from(storageNodes)
    .where(inDrive(storageNodes, drive));
  const [tombstones] = await ex
    .select({ revision: sql<string | null>`max(${storageTombstones.revision})` })
    .from(storageTombstones)
    .where(inDrive(storageTombstones, drive));
  return Math.max(Number(nodes?.revision ?? 0), Number(tombstones?.revision ?? 0));
}

export interface StorageSyncDrive {
  space: StorageSpace;
  revision: number;
}

export interface StorageSyncWorkspace {
  orgId: string;
  name: string;
  slug: string;
  /** The person's member in it: the drives below are this member's. */
  memberId: string;
  drives: StorageSyncDrive[];
}

/**
 * Every workspace the person belongs to (only `scopeOrgId` when set), with the drives they
 * sync there: their My files and, in a company, Shared, each with its revision.
 */
export async function listSyncWorkspaces(db: Db, userId: string, scopeOrgId?: string | null) {
  const rows = await db
    .select({
      orgId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      memberId: members.id,
      personal: sql<boolean>`exists (select 1 from ${personalSpaces} where ${personalSpaces.orgId} = ${organizations.id})`,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(
      and(
        eq(members.userId, userId),
        scopeOrgId ? eq(members.organizationId, scopeOrgId) : undefined,
      ),
    )
    .orderBy(asc(members.createdAt), asc(members.id));
  const workspaces: StorageSyncWorkspace[] = [];
  for (const row of rows) {
    const mine: Drive = { orgId: row.orgId, space: "personal", ownerMemberId: row.memberId };
    const drives: StorageSyncDrive[] = [
      { space: "personal", revision: await driveRevision(db, mine) },
    ];
    if (!row.personal) {
      const shared: Drive = { orgId: row.orgId, space: "shared", ownerMemberId: null };
      drives.push({ space: "shared", revision: await driveRevision(db, shared) });
    }
    workspaces.push({
      orgId: row.orgId,
      name: row.name,
      slug: row.slug,
      memberId: row.memberId,
      drives,
    });
  }
  return workspaces satisfies StorageSyncWorkspace[];
}

/**
 * For the daily cron: deletes tombstones made before `before`, and raises each workspace's
 * cursor floor past them so a client that had not reached them lists its drive again. Returns
 * how many went and whether more are waiting. Safe to run twice.
 */
export async function sweepStorageTombstones(db: Db, options: { before: Date; limit?: number }) {
  const limit = options.limit ?? 1000;
  const due = await db
    .select({ id: storageTombstones.id })
    .from(storageTombstones)
    .where(lt(storageTombstones.createdAt, options.before))
    .orderBy(asc(storageTombstones.createdAt))
    .limit(limit + 1);
  const ids = due.slice(0, limit).map((row) => row.id);
  if (ids.length === 0) return { deleted: 0, more: false };
  await db.transaction(async (tx) => {
    const gone = await tx
      .delete(storageTombstones)
      .where(inArray(storageTombstones.id, ids))
      .returning({ orgId: storageTombstones.orgId, revision: storageTombstones.revision });
    const highest = new Map<string, number>();
    for (const row of gone) {
      highest.set(row.orgId, Math.max(highest.get(row.orgId) ?? 0, row.revision));
    }
    for (const [orgId, revision] of highest) {
      await tx
        .update(storageSyncState)
        .set({ cursorFloor: sql`greatest(${storageSyncState.cursorFloor}, ${revision + 1})` })
        .where(eq(storageSyncState.orgId, orgId));
    }
  });
  return { deleted: ids.length, more: due.length > limit };
}
