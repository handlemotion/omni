// Storage internals (ADR 0034): the tree walks, the insert that numbers a taken name, and the
// usage counter. Nothing here decides access; `access.ts` does, and only `../storage.ts` hands
// these to callers.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { storageNodes, storageUsage } from "../schema/storage.ts";

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

export type StorageSpace = (typeof storageNodes.space.enumValues)[number];
export type StorageNodeKind = (typeof storageNodes.kind.enumValues)[number];
export type NodeRow = typeof storageNodes.$inferSelect;

/** A file or folder as callers see it: no object key, no link. */
export interface StorageNode {
  id: string;
  orgId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
  parentId: string | null;
  kind: StorageNodeKind;
  name: string;
  size: number;
  mimeType: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
}

export function toNode(row: NodeRow): StorageNode {
  return {
    id: row.id,
    orgId: row.orgId,
    space: row.space,
    ownerMemberId: row.ownerMemberId,
    parentId: row.parentId,
    kind: row.kind,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trashedAt: row.trashedAt,
  };
}

/** A drive: one member's My files, or a company's Shared. */
export interface Drive {
  orgId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
}

export const driveOf = (row: NodeRow): Drive => ({
  orgId: row.orgId,
  space: row.space,
  ownerMemberId: row.ownerMemberId,
});

export const sameDrive = (a: Drive, b: Drive) =>
  a.orgId === b.orgId && a.space === b.space && a.ownerMemberId === b.ownerMemberId;

/** The one rule for where a file's bytes live. The name is not in it. */
export const storageObjectKey = (orgId: string, fileId: string) => `orgs/${orgId}/${fileId}`;

/** The name as stored, or null when it cannot be one. */
export function cleanName(name: string): string | null {
  const clean = name.trim();
  if (!clean || clean === "." || clean === "..") return null;
  if (clean.length > STORAGE_NAME_MAX_LENGTH) return null;
  // A slash would read as a path; control characters break headers and listings.
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
export async function chainOf(ex: Db, nodeId: string): Promise<NodeRow[] | null> {
  const rows = await ex
    .select()
    .from(storageNodes)
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
}

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

/** SQL: the ids of the node and everything inside it, trashed or not, with their depth. */
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

/** The node and everything inside it, trashed or not. */
export async function subtreeOf(ex: Db, nodeId: string): Promise<SubtreeRow[]> {
  const rows = (await ex.execute(sql`${down(nodeId)}
    select n.id, n.kind, n.size, n.r2_key, down.depth
    from down join ${storageNodes} n on n.id = down.id`)) as unknown as {
    id: string;
    kind: StorageNodeKind;
    size: string | number;
    r2_key: string | null;
    depth: number;
  }[]; // postgres-js: the rows themselves
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    size: Number(row.size),
    r2Key: row.r2_key,
    depth: row.depth,
  }));
}

/** Rows that sit side by side: the children of `parentId`, or a drive's root when it is null. */
function siblings(drive: Drive, parentId: string | null) {
  return and(
    eq(storageNodes.orgId, drive.orgId),
    eq(storageNodes.space, drive.space),
    sql`coalesce(${storageNodes.ownerMemberId}, '') = ${drive.ownerMemberId ?? ""}`,
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
) {
  const limit = pageSize(page.limit);
  const after = page.cursor
    ? sql`(${storageNodes.kind}, lower(${storageNodes.name}), ${storageNodes.id}) > (${page.cursor.kind}::storage_node_kind, lower(${page.cursor.name}), ${page.cursor.id})`
    : undefined;
  const rows = await ex
    .select()
    .from(storageNodes)
    .where(and(siblings(drive, parentId), sql`${storageNodes.trashedAt} is null`, after))
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
): SQL<string> {
  // A file keeps its extension after the number; a folder has none.
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
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
        and coalesce(s.parent_id, '') = ${parentId ?? ""}
        and lower(s.name) = lower(c.name) and s.trashed_at is null${except}
    )
    order by c.n limit 1
  ), ${`${base} (${uuidv7()})${ext}`}::text)`;
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
  createdByMemberId: string | null;
}

/**
 * Inserts a node under the first free name. Two inserts that pick the same name collide on the
 * unique index; the loser inserts nothing and picks again.
 */
export async function insertNode(tx: Db, input: NewNode): Promise<NodeRow> {
  const id = input.id ?? uuidv7();
  for (let attempt = 0; attempt < 8; attempt++) {
    const [row] = await tx
      .insert(storageNodes)
      .values({
        id,
        orgId: input.drive.orgId,
        space: input.drive.space,
        ownerMemberId: input.drive.ownerMemberId,
        parentId: input.parentId,
        kind: input.kind,
        name: freeName(input.drive, input.parentId, input.name, input.kind),
        size: input.size ?? 0,
        mimeType: input.mimeType ?? null,
        r2Key: input.r2Key ?? null,
        createdByMemberId: input.createdByMemberId,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  throw new Error(`storage: no free name for "${input.name}"`);
}

/** Locks the workspace's usage row, creating it at zero, and returns its bytes. */
export async function lockUsage(tx: Db, orgId: string): Promise<number> {
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
 * Deletes a node and everything inside it and subtracts its bytes, rows first: the caller
 * deletes the returned objects afterwards. Call with the tree locked.
 */
export async function deleteSubtree(tx: Db, orgId: string, nodeId: string) {
  await lockUsage(tx, orgId);
  const rows = await subtreeOf(tx, nodeId);
  await tx.delete(storageNodes).where(eq(storageNodes.id, nodeId));
  const bytes = rows.reduce((sum, row) => sum + row.size, 0);
  if (bytes > 0) await addUsage(tx, orgId, -bytes);
  return { r2Keys: rows.flatMap((row) => (row.r2Key ? [row.r2Key] : [])), bytes };
}
