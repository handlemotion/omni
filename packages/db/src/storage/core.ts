import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes, storageUsage, storageVersions } from "../schema/storage.ts";
import { leaveTombstones, nextRevision } from "./revision.ts";

/** Folders nest this deep at most where people create or move them. */
export const STORAGE_MAX_DEPTH = 32;
/**
 * Where a walk up or down the tree gives up. Not the depth cap: a hand-over puts a tree one
 * folder deeper each time it changes hands (`handover.ts`), so a tree can be deeper than anyone
 * could build it and must still be reached, listed, trashed and purged whole. Parents cannot
 * form a cycle (a move checks for one under the tree lock), so this only bounds a walk over
 * rows that should not exist.
 */
export const MAX_WALK = 256;
export const STORAGE_NAME_MAX_LENGTH = 255;
const MAX_EXTENSION = 32;

export type StorageSpace = (typeof storageNodes.space.enumValues)[number];
export type StorageNodeKind = (typeof storageNodes.kind.enumValues)[number];
/** A node's row; read through `nodeColumns`, it also says since when it is locked (`lock.ts`). */
export type NodeRow = typeof storageNodes.$inferSelect & { lockedAt?: Date | null };

/** A node's columns and its lock's `locked_at`, for a select left-joined with `lockJoin`. */
export const nodeColumns = { ...getTableColumns(storageNodes), lockedAt: storageLocks.lockedAt };
export const lockJoin = eq(storageLocks.nodeId, storageNodes.id);

/** A file or folder as callers see it: no object key, no link. */
export interface StorageNode {
  id: string;
  orgId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
  /** The teamspace it is in, when `space` is `teamspace`. */
  teamspaceId: string | null;
  parentId: string | null;
  kind: StorageNodeKind;
  name: string;
  size: number;
  mimeType: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
  /** Set on a locked file: see `lock.ts`. */
  lockedAt: Date | null;
  /** The workspace's sync revision at the node's last change. */
  revision: number;
  /** Goes up each time the file's bytes are replaced in place. */
  contentVersion: number;
  /** Hex SHA-256 of the bytes when the uploader sent it. */
  contentSha256: string | null;
  /** Only the workspace's members see it: a grant or link above it does not reach in. */
  teamOnly: boolean;
}

export function toNode(row: NodeRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    space: row.space,
    ownerMemberId: row.ownerMemberId,
    teamspaceId: row.teamspaceId,
    parentId: row.parentId,
    kind: row.kind,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trashedAt: row.trashedAt,
    lockedAt: row.lockedAt ?? null,
    revision: row.revision,
    contentVersion: row.contentVersion,
    contentSha256: row.contentSha256,
    teamOnly: row.teamOnly,
  } satisfies StorageNode;
}

/** A drive: one member's My files, a company's Shared, or one of its teamspaces. */
export interface Drive {
  orgId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
  teamspaceId: string | null;
}

export const driveOf = (row: Pick<NodeRow, "orgId" | "space" | "ownerMemberId" | "teamspaceId">) =>
  ({
    orgId: row.orgId,
    space: row.space,
    ownerMemberId: row.ownerMemberId,
    teamspaceId: row.teamspaceId,
  }) satisfies Drive;

export const sameDrive = (a: Drive, b: Drive) =>
  a.orgId === b.orgId &&
  a.space === b.space &&
  a.ownerMemberId === b.ownerMemberId &&
  a.teamspaceId === b.teamspaceId;

/** The drives of a workspace that are not a teamspace: a member's My files, and Shared. */
export const personalDrive = (orgId: string, memberId: string) =>
  ({ orgId, space: "personal", ownerMemberId: memberId, teamspaceId: null }) satisfies Drive;
export const sharedDrive = (orgId: string) =>
  ({ orgId, space: "shared", ownerMemberId: null, teamspaceId: null }) satisfies Drive;
export const teamspaceDrive = (orgId: string, teamspaceId: string) =>
  ({ orgId, space: "teamspace", ownerMemberId: null, teamspaceId }) satisfies Drive;

/** SQL condition: the row at `alias` (a node, upload or tombstone) is in `drive`. */
export function inDriveSql(drive: Drive, alias: string) {
  const t = sql.raw(alias);
  return sql`(${t}.org_id = ${drive.orgId} and ${t}.space = ${drive.space}
    and coalesce(${t}.owner_member_id, '') = ${drive.ownerMemberId ?? ""}
    and coalesce(${t}.teamspace_id, '') = ${drive.teamspaceId ?? ""})`;
}

/** The one rule for where a file's bytes live. The name is not in it. */
export const storageObjectKey = (orgId: string, fileId: string) => `orgs/${orgId}/${fileId}`;

/** The name as stored, or null when it cannot be one. */
export function cleanName(name: string) {
  const clean = name.trim();
  if (!clean || clean === "." || clean === "..") return null;
  if (clean.length > STORAGE_NAME_MAX_LENGTH) return null;
  // oxlint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}

export function isUniqueViolation(error: unknown) {
  return (
    (error as { cause?: { code?: string } }).cause?.code === "23505" ||
    (error as { code?: string }).code === "23505"
  );
}

/**
 * Serializes changes to one workspace's tree shape (create folder, move, delete), so two moves
 * cannot build a cycle between them and a folder cannot be filled while it is being deleted.
 * Taken before the usage row, which is taken before an upload row.
 */
export async function lockTree(tx: Db, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`storage-tree:${orgId}`}))`);
}

export async function orgOfNode(ex: Db, nodeId: string) {
  const [row] = await ex
    .select({ orgId: storageNodes.orgId })
    .from(storageNodes)
    .where(eq(storageNodes.id, nodeId));
  return row?.orgId ?? null;
}

/**
 * The node and its ancestors, node first, root last. Null when there is no such node, or its
 * chain does not reach a root within `MAX_WALK`.
 */
export const chainOf: (ex: Db, nodeId: string) => Promise<NodeRow[] | null> = async (
  ex,
  nodeId,
) => {
  const rows = await ex
    .select(nodeColumns)
    .from(storageNodes)
    .leftJoin(storageLocks, lockJoin)
    .where(
      sql`${storageNodes.id} in (
        with recursive up(id, parent_id, depth) as (
          select n.id, n.parent_id, 0 from ${storageNodes} n where n.id = ${nodeId}
          union all
          select p.id, p.parent_id, up.depth + 1 from ${storageNodes} p
            join up on p.id = up.parent_id where up.depth < ${MAX_WALK}
        ) select id from up)`,
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: NodeRow[] = [];
  let next = byId.get(nodeId);
  while (next) {
    chain.push(next);
    if (next.parentId === null) return chain;
    next = byId.get(next.parentId);
  }
  return null;
};

/** True when the node at the bottom of `chain`, or a folder above it, is in Trash. */
export const inTrash = (chain: NodeRow[]) => chain.some((row) => row.trashedAt !== null);

export interface SubtreeRow {
  id: string;
  kind: StorageNodeKind;
  size: number;
  r2Key: string | null;
  /** 0 for the node itself. */
  depth: number;
}

const down = (nodeId: string) => sql`
  with recursive down(id, depth) as (
    select n.id, 0 from ${storageNodes} n where n.id = ${nodeId}
    union all
    select c.id, down.depth + 1 from ${storageNodes} c
      join down on c.parent_id = down.id where down.depth < ${MAX_WALK}
  )`;

/** SQL condition: `storage_nodes.id` is inside the node, not the node itself. */
export const isInside = (nodeId: string) =>
  sql`${storageNodes.id} in (${down(nodeId)} select id from down where depth > 0)`;

/** SQL condition: `column` names the node or something inside it. */
export const inSubtree = (column: SQL | AnyPgColumn, nodeId: string) =>
  sql`${column} in (${down(nodeId)} select id from down)`;

/** SQL condition: `storage_nodes.id` is the node or inside it. */
export const isSubtree = (nodeId: string) => inSubtree(storageNodes.id, nodeId);

/** The node and everything inside it, trashed or not. */
export async function subtreeOf(ex: Db, nodeId: string) {
  const rows = (await ex.execute(sql`${down(nodeId)}
    select n.id, n.kind, n.size, n.r2_key, down.depth
    from down join ${storageNodes} n on n.id = down.id`)) as unknown as {
    id: string;
    kind: StorageNodeKind;
    size: string | number;
    r2_key: string | null;
    depth: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    size: Number(row.size),
    r2Key: row.r2_key,
    depth: row.depth,
  })) satisfies SubtreeRow[];
}

/**
 * True when something inside the node (not the node itself) was made by someone other than
 * `memberId`: what keeps a folder in Shared from being its maker's alone to take away.
 */
export async function holdsOthersWork(ex: Db, nodeId: string, memberId: string) {
  const [row] = await ex
    .select({ id: storageNodes.id })
    .from(storageNodes)
    .where(
      and(isInside(nodeId), sql`${storageNodes.createdByMemberId} is distinct from ${memberId}`),
    )
    .limit(1);
  return row !== undefined;
}

/** True when the node is a locked file, or a folder with one inside it at any depth. */
export async function holdsLocked(ex: Db, nodeId: string) {
  const [row] = await ex
    .select({ id: storageLocks.nodeId })
    .from(storageLocks)
    .where(sql`${storageLocks.nodeId} in (${down(nodeId)} select id from down)`)
    .limit(1);
  return row !== undefined;
}

function siblings(drive: Drive, parentId: string | null) {
  return and(
    eq(storageNodes.orgId, drive.orgId),
    eq(storageNodes.space, drive.space),
    sql`coalesce(${storageNodes.ownerMemberId}, '') = ${drive.ownerMemberId ?? ""}`,
    sql`coalesce(${storageNodes.teamspaceId}, '') = ${drive.teamspaceId ?? ""}`,
    sql`coalesce(${storageNodes.parentId}, '') = ${parentId ?? ""}`,
  );
}

export interface StorageListCursor {
  kind: StorageNodeKind;
  name: string;
  id: string;
}

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 200;
export const pageSize = (limit?: number) =>
  Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE), 1), MAX_PAGE);

/** A folder's live children: folders first, then by name, a page at a time. */
export async function listChildren(
  ex: Db,
  drive: Drive,
  parentId: string | null,
  page: { cursor?: StorageListCursor | null; limit?: number },
  teamOnlyHidden = false,
) {
  const limit = pageSize(page.limit);
  const after = page.cursor
    ? sql`(${storageNodes.kind}, lower(${storageNodes.name}), ${storageNodes.id}) > (${page.cursor.kind}::storage_node_kind, lower(${page.cursor.name}), ${page.cursor.id})`
    : undefined;
  const rows = await ex
    .select(nodeColumns)
    .from(storageNodes)
    .leftJoin(storageLocks, lockJoin)
    .where(
      and(
        siblings(drive, parentId),
        sql`${storageNodes.trashedAt} is null`,
        teamOnlyHidden ? sql`not ${storageNodes.teamOnly}` : undefined,
        after,
      ),
    )
    .orderBy(storageNodes.kind, sql`lower(${storageNodes.name})`, storageNodes.id)
    .limit(limit + 1);
  const nodes = rows.slice(0, limit);
  const last = nodes.at(-1);
  const nextCursor: StorageListCursor | null =
    rows.length > limit && last ? { kind: last.kind, name: last.name, id: last.id } : null;
  return { nodes: nodes.map(toNode), nextCursor };
}

/**
 * SQL for the name a node gets among the live children of `parentId`: `name` when it is free,
 * else the first free `name (n).ext`. Evaluated inside the insert or update that uses it; the
 * unique index settles two writers that pick the same one.
 */
export function freeName(
  drive: Drive,
  parentId: string | null,
  name: string,
  kind: StorageNodeKind,
  exceptId?: string,
) {
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const split = dot > 0 && name.length - dot <= MAX_EXTENSION;
  const ext = split ? name.slice(dot) : "";
  const room = (suffix: number) => STORAGE_NAME_MAX_LENGTH - ext.length - suffix;
  const whole = split ? name.slice(0, dot) : name;
  const base = whole.slice(0, room(" (999)".length)).trimEnd();
  const last = whole.slice(0, room(" ()".length + 36)).trimEnd();
  const except = exceptId ? sql` and s.id <> ${exceptId}` : sql``;
  return sql<string>`coalesce((
    select c.name from (
      select g.n, case when g.n = 0 then ${name}::text
        else ${base}::text || ' (' || g.n || ')' || ${ext}::text end as name
      from generate_series(0, 999) as g(n)
    ) c
    where not exists (
      select 1 from ${storageNodes} s
      where s.org_id = ${drive.orgId} and s.space = ${drive.space}
        and coalesce(s.owner_member_id, '') = ${drive.ownerMemberId ?? ""}
        and coalesce(s.teamspace_id, '') = ${drive.teamspaceId ?? ""}
        and coalesce(s.parent_id, '') = ${parentId ?? ""}
        and lower(s.name) = lower(c.name) and s.trashed_at is null${except}
    )
    order by c.n limit 1
  ), ${`${last} (${uuidv7()})${ext}`}::text)` satisfies SQL<string>;
}

export interface NewNode {
  id?: string;
  drive: Drive;
  parentId: string | null;
  kind: StorageNodeKind;
  name: string;
  size?: number;
  mimeType?: string | null;
  r2Key?: string | null;
  contentSha256?: string | null;
  createdByMemberId: string | null;
  teamOnly?: boolean;
  attached?: boolean;
}

/**
 * Inserts a node under the first free name. Two inserts that pick the same name collide on the
 * unique index; the loser inserts nothing and picks again.
 */
export async function insertNode(tx: Db, input: NewNode) {
  const id = input.id ?? uuidv7();
  const revision = await nextRevision(tx, input.drive.orgId);
  for (let attempt = 0; attempt < 8; attempt++) {
    const [row] = await tx
      .insert(storageNodes)
      .values({
        id,
        orgId: input.drive.orgId,
        space: input.drive.space,
        ownerMemberId: input.drive.ownerMemberId,
        teamspaceId: input.drive.teamspaceId,
        parentId: input.parentId,
        kind: input.kind,
        name: freeName(input.drive, input.parentId, input.name, input.kind),
        size: input.size ?? 0,
        mimeType: input.mimeType ?? null,
        r2Key: input.r2Key ?? null,
        contentSha256: input.contentSha256 ?? null,
        createdByMemberId: input.createdByMemberId,
        teamOnly: input.teamOnly ?? false,
        attached: input.attached ?? false,
        revision,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row satisfies NodeRow;
  }
  throw new Error(`storage: no free name for node ${id}`);
}

/** Locks the workspace's usage row, creating it at zero, and returns its bytes. */
export async function lockUsage(tx: Db, orgId: string) {
  await tx.insert(storageUsage).values({ orgId, bytes: 0 }).onConflictDoNothing();
  const [row] = await tx
    .select({ bytes: storageUsage.bytes })
    .from(storageUsage)
    .where(eq(storageUsage.orgId, orgId))
    .for("update");
  return row?.bytes ?? 0;
}

/** Call with the usage row locked. Never goes below zero. */
export async function addUsage(tx: Db, orgId: string, delta: number) {
  await tx
    .update(storageUsage)
    .set({ bytes: sql`greatest(${storageUsage.bytes} + ${delta}, 0)` })
    .where(eq(storageUsage.orgId, orgId));
}

/**
 * Deletes a node and everything inside it, kept versions included (they cascade with their
 * file), and subtracts the bytes, rows first: the caller deletes the returned objects
 * afterwards. Call with the tree locked.
 */
export async function deleteSubtree(tx: Db, orgId: string, nodeId: string) {
  await lockUsage(tx, orgId);
  const rows = await subtreeOf(tx, nodeId);
  const revision = await nextRevision(tx, orgId);
  await leaveTombstones(tx, isSubtree(nodeId), revision);
  const versions = await tx
    .select({ size: storageVersions.size, r2Key: storageVersions.r2Key })
    .from(storageVersions)
    .where(inSubtree(storageVersions.nodeId, nodeId));
  await tx.delete(storageNodes).where(eq(storageNodes.id, nodeId));
  const owned = [...rows, ...versions];
  const bytes = owned.reduce((sum, row) => sum + row.size, 0);
  if (bytes > 0) await addUsage(tx, orgId, -bytes);
  return { r2Keys: owned.flatMap((row) => (row.r2Key ? [row.r2Key] : [])), bytes };
}
