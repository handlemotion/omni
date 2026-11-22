import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes } from "../schema/storage.ts";
import { editsContent, type Access, type Door, type StorageRole } from "./access.ts";
import {
  chainOf,
  cleanName,
  driveOf,
  freeName,
  holdsLocked,
  inTrash,
  insertNode,
  isInside,
  isSubtree,
  isUniqueViolation,
  listChildren,
  lockTree,
  orgOfNode,
  sameDrive,
  STORAGE_MAX_DEPTH,
  subtreeOf,
  toNode,
  type Drive,
  type NodeRow,
  type StorageListCursor,
  type StorageNode,
  type StorageSpace,
} from "./core.ts";
import { leaveTombstones, nextRevision } from "./revision.ts";

/** Where something goes or is listed: inside a folder, or at the root of a drive. */
export type StoragePlace =
  | { parentId: string }
  | { space: Exclude<StorageSpace, "teamspace"> }
  | { teamspaceId: string };

/** Where a row with a drive and a folder (an upload, a node) sits: its folder, or its drive's root. */
export const placeOf = (row: {
  parentId: string | null;
  space: StorageSpace;
  teamspaceId: string | null;
}) =>
  (row.parentId
    ? { parentId: row.parentId }
    : row.teamspaceId
      ? { teamspaceId: row.teamspaceId }
      : { space: row.space === "personal" ? "personal" : "shared" }) satisfies StoragePlace;

export interface StoragePathEntry {
  id: string;
  name: string;
}

/** A node as a door shows it. `path` runs from the highest folder the door opens to the node. */
export interface StorageNodeView {
  node: StorageNode;
  role: StorageRole;
  path: StoragePathEntry[];
  /** In Trash itself or inside a folder that is: only a member reaches such a node. */
  inTrash: boolean;
}

export type NotFound = { status: "not_found" };
/** Reachable, but the holder's role does not allow the change. */
export type Forbidden = { status: "forbidden" };
export type InvalidName = { status: "invalid_name" };
export type TooDeep = { status: "too_deep" };
/** A locked file, or a folder holding one, refuses the change. */
export type Locked = { status: "locked" };
/** The node changed since the revision the caller read; nothing was changed. */
export type VersionConflict = { status: "version_conflict" };

/** What a sync client read: a change is refused when the node has moved on since. */
export interface StorageGuard {
  ifRevision?: number;
}

export type ListResult =
  | {
      status: "ok";
      /** The folder listed; null at the root of a space. */
      folder: StorageNodeView | null;
      nodes: StorageNode[];
      nextCursor: StorageListCursor | null;
    }
  | NotFound;
export type NodeResult = { status: "ok"; node: StorageNode } | NotFound | Forbidden;
export type CreateFolderResult = NodeResult | InvalidName | TooDeep;
export type RenameResult =
  | NodeResult
  | InvalidName
  | Locked
  | VersionConflict
  | { status: "name_taken" };
export type MoveResult =
  | {
      status: "ok";
      node: StorageNode;
      /** The drive it left, when it changed drives. */
      left: Drive | null;
      /** The folder it was in before (`null` for its drive's top). */
      fromParentId: string | null;
    }
  | NotFound
  | Forbidden
  | TooDeep
  | Locked
  | VersionConflict
  | { status: "cycle" };
export type TrashResult = NodeResult | Locked | VersionConflict;
export type FileResult = { status: "ok"; file: StorageNode; r2Key: string } | NotFound;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;
export const LOCKED = { status: "locked" } as const;
export const VERSION_CONFLICT = { status: "version_conflict" } as const;
/** For an update that is not an edit of the row, such as a new revision: "Modified" stays. */
export const keepUpdatedAt = sql<Date>`${storageNodes.updatedAt}`;

/** True when the guard names a revision the node is no longer at. */
export const stale = (node: NodeRow, guard?: StorageGuard) =>
  guard?.ifRevision !== undefined && node.revision !== guard.ifRevision;

const view = (chain: NodeRow[], access: Access) =>
  ({
    node: toNode(chain[0]!),
    role: access.role,
    path: chain
      .slice(0, access.top + 1)
      .toReversed()
      .map((row) => ({ id: row.id, name: row.name })),
    inTrash: inTrash(chain),
  }) satisfies StorageNodeView;

/** The node's chain and what the door allows on it, or null when the door opens nothing. */
export async function reach(ex: Db, door: Door, nodeId: string) {
  const chain = await chainOf(ex, nodeId);
  if (!chain) return null;
  const access = await door.access(ex, chain);
  return access ? { chain, node: chain[0]!, access } : null;
}

type Reached = NonNullable<Awaited<ReturnType<typeof reach>>>;

const placeIn = (found: Reached, writable: boolean, attached: boolean) => ({
  drive: driveOf(found.node),
  parentId: found.node.id as string | null,
  depth: found.chain.length,
  writable,
  chain: found.chain,
  access: found.access as Access | null,
  attached,
});

/** A live place to list or write in, resolved through the door. */
export async function resolvePlace(ex: Db, door: Door, place: StoragePlace) {
  if ("parentId" in place) {
    const found = await reach(ex, door, place.parentId);
    if (!found || found.node.kind !== "folder" || inTrash(found.chain)) return null;
    return placeIn(found, found.access.inside, false);
  }
  const drive =
    "teamspaceId" in place
      ? await door.teamspace(ex, place.teamspaceId)
      : await door.root(ex, place.space);
  if (!drive) return null;
  return {
    drive,
    parentId: null,
    depth: 0,
    writable: true,
    chain: [] as NodeRow[],
    access: null,
    attached: false,
  };
}

const PAGE_TYPES = new Set(["text/vnd.omni.doc", "text/vnd.omni.canvas"]);
const holdsImages = (node: { name: string; mimeType: string | null }) =>
  PAGE_TYPES.has(node.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "") ||
  /\.(md|markdown)$/i.test(node.name);
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

/**
 * Where an upload named `name` goes: `place`, as for anything else, or, for an image whose place
 * is a doc or a canvas, into it. Such an image belongs to it (`attached`): whoever may edit the
 * doc or canvas may add one, and whoever reaches it reaches its images.
 */
export async function resolveUploadPlace(ex: Db, door: Door, place: StoragePlace, name: string) {
  if (!("parentId" in place)) return resolvePlace(ex, door, place);
  const found = await reach(ex, door, place.parentId);
  if (!found || inTrash(found.chain)) return null;
  if (found.node.kind === "folder") return placeIn(found, found.access.inside, false);
  if (found.node.attached || !holdsImages(found.node) || !isImageName(name)) return null;
  return placeIn(found, editsContent(found.access) && !found.node.lockedAt, true);
}

/** Runs `fn` again when two writers picked the same free name and the unique index refused one. */
export async function retryNameRace<T>(fn: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 4 || !isUniqueViolation(error)) throw error;
    }
  }
}

async function folderHeight(ex: Db, nodeId: string) {
  const rows = await subtreeOf(ex, nodeId);
  return Math.max(0, ...rows.filter((row) => row.kind === "folder").map((row) => row.depth + 1));
}

async function leavingRefusal(tx: Db, door: Door, found: { node: NodeRow; access: Access }) {
  if (door.kind !== "member" || !found.access.remove) return FORBIDDEN;
  if (!(await door.removesWhole(tx, found.node))) return FORBIDDEN;
  if (await holdsLocked(tx, found.node.id)) return LOCKED;
  return null;
}

const stuck = (node: NodeRow, access: Access, filing?: boolean) =>
  Boolean(node.lockedAt) && !(filing && access.role === "member");

const moveInto: (
  tx: Db,
  door: Door,
  nodeId: string,
  to: StoragePlace,
  guard?: StorageGuard,
  filing?: boolean,
) => Promise<MoveResult> = async (tx, door, nodeId, to, guard, filing) => {
  const orgId = await orgOfNode(tx, nodeId);
  if (!orgId) return NOT_FOUND;
  await lockTree(tx, orgId);
  const found = await reach(tx, door, nodeId);
  if (!found || inTrash(found.chain)) return NOT_FOUND;
  if (!found.access.change) return FORBIDDEN;
  const { node } = found;
  if (stale(node, guard)) return VERSION_CONFLICT;
  if (stuck(node, found.access, filing)) return LOCKED;
  const dest = await resolvePlace(tx, door, to);
  if (!dest) return NOT_FOUND;
  if (!dest.writable || dest.drive.orgId !== node.orgId) return FORBIDDEN;
  if (dest.chain.some((row) => row.id === node.id)) return { status: "cycle" };
  const from = driveOf(node);
  const crossing = !sameDrive(from, dest.drive);
  if (crossing) {
    const refusal = await leavingRefusal(tx, door, found);
    if (refusal) return refusal;
  }
  if (node.parentId === dest.parentId && !crossing) {
    return { status: "ok", node: toNode(node), left: null, fromParentId: node.parentId };
  }
  if (
    node.kind === "folder" &&
    dest.depth + (await folderHeight(tx, node.id)) > STORAGE_MAX_DEPTH
  ) {
    return { status: "too_deep" };
  }
  const revision = await nextRevision(tx, node.orgId);
  if (crossing) {
    await leaveTombstones(tx, isSubtree(node.id), revision);
    await tx
      .update(storageNodes)
      .set({
        space: dest.drive.space,
        ownerMemberId: dest.drive.ownerMemberId,
        teamspaceId: dest.drive.teamspaceId,
        revision,
        updatedAt: keepUpdatedAt,
      })
      .where(isInside(node.id));
  }
  const [moved] = await tx
    .update(storageNodes)
    .set({
      space: dest.drive.space,
      ownerMemberId: dest.drive.ownerMemberId,
      teamspaceId: dest.drive.teamspaceId,
      parentId: dest.parentId,
      name: freeName(dest.drive, dest.parentId, node.name, node.kind, node.id),
      revision,
    })
    .where(eq(storageNodes.id, node.id))
    .returning();
  return moved
    ? {
        status: "ok",
        node: toNode(moved),
        left: crossing ? from : null,
        fromParentId: node.parentId,
      }
    : NOT_FOUND;
};

/** What a member and a grantee can both do, each bounded by their door. */
export function treeOperations(db: Db, door: Door) {
  return {
    async node(nodeId: string) {
      const found = await reach(db, door, nodeId);
      return (found ? view(found.chain, found.access) : null) satisfies StorageNodeView | null;
    },

    async nodeByShareId(shareId: string) {
      const [row] = await db
        .select({ id: storageNodes.id })
        .from(storageNodes)
        .where(eq(storageNodes.shareId, shareId));
      if (!row) return null satisfies StorageNodeView | null;
      const found = await reach(db, door, row.id);
      return (
        found && !inTrash(found.chain) ? view(found.chain, found.access) : null
      ) satisfies StorageNodeView | null;
    },

    async list(
      place: StoragePlace,
      page: { cursor?: StorageListCursor | null; limit?: number } = {},
    ) {
      const at = await resolvePlace(db, door, place);
      if (!at) return NOT_FOUND satisfies ListResult;
      const guest = Boolean(at.access && at.access.role !== "member");
      const { nodes, nextCursor } = await listChildren(db, at.drive, at.parentId, page, guest);
      const folder = at.access ? view(at.chain, at.access) : null;
      return { status: "ok", folder, nodes, nextCursor } satisfies ListResult;
    },

    async createFolder(place: StoragePlace, name: string, options: { teamOnly?: boolean } = {}) {
      const clean = cleanName(name);
      if (!clean) return { status: "invalid_name" } satisfies CreateFolderResult;
      return db.transaction<CreateFolderResult>(async (tx) => {
        const first = await resolvePlace(tx, door, place);
        if (!first) return NOT_FOUND;
        await lockTree(tx, first.drive.orgId);
        const at = await resolvePlace(tx, door, place);
        if (!at) return NOT_FOUND;
        if (!at.writable) return FORBIDDEN;
        if (options.teamOnly && (at.access?.role ?? "member") !== "member") return FORBIDDEN;
        if (at.depth + 1 > STORAGE_MAX_DEPTH) return { status: "too_deep" as const };
        const actor = await door.actor(tx, at.drive.orgId);
        if (!actor) return FORBIDDEN;
        const row = await insertNode(tx, {
          drive: at.drive,
          parentId: at.parentId,
          kind: "folder",
          name: clean,
          createdByMemberId: actor,
          teamOnly: options.teamOnly ?? false,
        });
        return { status: "ok" as const, node: toNode(row) };
      });
    },

    async rename(nodeId: string, name: string, guard?: StorageGuard) {
      const clean = cleanName(name);
      if (!clean) return { status: "invalid_name" } satisfies RenameResult;
      try {
        return (await db.transaction(async (tx) => {
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) {
            const result: RenameResult = NOT_FOUND;
            return result;
          }
          await lockTree(tx, orgId);
          const found = await reach(tx, door, nodeId);
          if (!found || inTrash(found.chain)) {
            const result: RenameResult = NOT_FOUND;
            return result;
          }
          if (!found.access.change) {
            const result: RenameResult = FORBIDDEN;
            return result;
          }
          if (stale(found.node, guard)) {
            const result: RenameResult = VERSION_CONFLICT;
            return result;
          }
          if (found.node.lockedAt) {
            const result: RenameResult = LOCKED;
            return result;
          }
          const revision = await nextRevision(tx, orgId);
          const [row] = await tx
            .update(storageNodes)
            .set({ name: clean, revision })
            .where(
              sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is null and not exists (select 1 from ${storageLocks} where ${storageLocks.nodeId} = ${storageNodes.id})`,
            )
            .returning();
          const result: RenameResult = row ? { status: "ok", node: toNode(row) } : NOT_FOUND;
          return result;
        })) satisfies RenameResult;
      } catch (error) {
        if (isUniqueViolation(error)) return { status: "name_taken" } satisfies RenameResult;
        throw error;
      }
    },

    move(nodeId: string, to: StoragePlace, guard?: StorageGuard) {
      return retryNameRace(() =>
        db.transaction((tx) => moveInto(tx, door, nodeId, to, guard)),
      ) satisfies Promise<MoveResult>;
    },

    fileAway(nodeId: string, to: StoragePlace) {
      return retryNameRace(() =>
        db.transaction((tx) => moveInto(tx, door, nodeId, to, undefined, true)),
      ) satisfies Promise<MoveResult>;
    },

    trash(nodeId: string, guard?: StorageGuard) {
      return db.transaction<TrashResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies TrashResult;
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found) return NOT_FOUND satisfies TrashResult;
        if (found.node.trashedAt)
          return { status: "ok", node: toNode(found.node) } satisfies TrashResult;
        if (inTrash(found.chain)) return NOT_FOUND satisfies TrashResult;
        if (!found.access.remove || !(await door.removesWhole(tx, found.node)))
          return FORBIDDEN satisfies TrashResult;
        if (stale(found.node, guard)) return VERSION_CONFLICT satisfies TrashResult;
        if (await holdsLocked(tx, nodeId)) return LOCKED satisfies TrashResult;
        const revision = await nextRevision(tx, orgId);
        await tx
          .update(storageNodes)
          .set({ revision, updatedAt: keepUpdatedAt })
          .where(isInside(nodeId));
        const [row] = await tx
          .update(storageNodes)
          .set({ trashedAt: new Date(), revision })
          .where(sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is null`)
          .returning();
        return { status: "ok", node: toNode(row ?? found.node) } satisfies TrashResult;
      });
    },

    async file(nodeId: string) {
      const found = await reach(db, door, nodeId);
      if (!found || found.node.kind !== "file" || !found.node.r2Key)
        return NOT_FOUND satisfies FileResult;
      return {
        status: "ok",
        file: toNode(found.node),
        r2Key: found.node.r2Key,
      } satisfies FileResult;
    },
  };
}
