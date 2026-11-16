// Browsing and changing the folder tree through a door (ADR 0034 decisions 2 and 3): look up,
// list, create a folder, rename, move, trash, and the file lookup a download needs.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks } from "../schema/storage.ts";
import { storageNodes } from "./stored.ts";
import type { Access, Door, StorageRole } from "./access.ts";
import {
  chainOf,
  cleanName,
  driveOf,
  freeName,
  holdsLocked,
  inTrash,
  insertNode,
  isInside,
  isUniqueViolation,
  listChildren,
  lockTree,
  orgOfNode,
  sameDrive,
  STORAGE_MAX_DEPTH,
  subtreeOf,
  toNode,
  type NodeRow,
  type StorageListCursor,
  type StorageNode,
  type StorageSpace,
} from "./core.ts";

/** Where something goes or is listed: inside a folder, or at the root of a space. */
export type StoragePlace = { parentId: string } | { space: StorageSpace };

export interface StoragePathEntry {
  id: string;
  name: string;
}

/** A node as a door shows it. `path` runs from the highest folder the door opens to the node. */
export interface StorageNodeView {
  node: StorageNode;
  role: StorageRole;
  path: StoragePathEntry[];
}

export type NotFound = { status: "not_found" };
/** Reachable, but the holder's role does not allow the change. */
export type Forbidden = { status: "forbidden" };
export type InvalidName = { status: "invalid_name" };
export type TooDeep = { status: "too_deep" };
/** A locked file, or a folder holding one, refuses the change (ADR 0036 decision 6). */
export type Locked = { status: "locked" };

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
export type RenameResult = NodeResult | InvalidName | Locked | { status: "name_taken" };
export type MoveResult = NodeResult | TooDeep | Locked | { status: "cycle" };
export type TrashResult = NodeResult | Locked;
export type FileResult = { status: "ok"; file: StorageNode; r2Key: string } | NotFound;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;
export const LOCKED = { status: "locked" } as const;

const view = (chain: NodeRow[], access: Access): StorageNodeView => ({
  node: toNode(chain[0]!),
  role: access.role,
  path: chain
    .slice(0, access.top + 1)
    .toReversed()
    .map((row) => ({ id: row.id, name: row.name })),
});

/** The node's chain and what the door allows on it, or null when the door opens nothing. */
export async function reach(ex: Db, door: Door, nodeId: string) {
  const chain = await chainOf(ex, nodeId);
  if (!chain) return null;
  const access = await door.access(ex, chain);
  return access ? { chain, node: chain[0]!, access } : null;
}

/** A live place to list or write in, resolved through the door. */
export async function resolvePlace(ex: Db, door: Door, place: StoragePlace) {
  if ("parentId" in place) {
    const found = await reach(ex, door, place.parentId);
    if (!found || found.node.kind !== "folder" || inTrash(found.chain)) return null;
    return {
      drive: driveOf(found.node),
      parentId: found.node.id as string | null,
      /** How many folders deep the place is; a root is 0. */
      depth: found.chain.length,
      writable: found.access.inside,
      chain: found.chain,
      access: found.access as Access | null,
    };
  }
  const drive = await door.root(ex, place.space);
  if (!drive) return null;
  return { drive, parentId: null, depth: 0, writable: true, chain: [] as NodeRow[], access: null };
}

/** Runs `fn` again when two writers picked the same free name and the unique index refused one. */
export async function retryNameRace<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 4 || !isUniqueViolation(error)) throw error;
    }
  }
}

/** How many folders tall the subtree is: 1 for an empty folder, 0 for a file. */
async function folderHeight(ex: Db, nodeId: string) {
  const rows = await subtreeOf(ex, nodeId);
  return Math.max(0, ...rows.filter((row) => row.kind === "folder").map((row) => row.depth + 1));
}

/** Why a node may not leave its drive through this door, or null when it may. */
async function leavingRefusal(tx: Db, door: Door, found: { node: NodeRow; access: Access }) {
  // Taking a node out of Shared is trashing it for everyone else, and a grant never reaches
  // past the drive it was made in.
  if (door.kind !== "member" || !found.access.remove) return FORBIDDEN;
  if (!(await door.removesWhole(tx, found.node))) return FORBIDDEN;
  // Out of its drive is out of reach of everyone who could see a locked file inside.
  if (await holdsLocked(tx, found.node.id)) return LOCKED;
  return null;
}

async function moveInto(tx: Db, door: Door, nodeId: string, to: StoragePlace): Promise<MoveResult> {
  const orgId = await orgOfNode(tx, nodeId);
  if (!orgId) return NOT_FOUND;
  await lockTree(tx, orgId);
  const found = await reach(tx, door, nodeId);
  if (!found || inTrash(found.chain)) return NOT_FOUND;
  if (!found.access.change) return FORBIDDEN;
  const { node } = found;
  if (node.lockedAt) return LOCKED;
  const dest = await resolvePlace(tx, door, to);
  if (!dest) return NOT_FOUND;
  // A move stays in its workspace (ADR 0034 decision 6).
  if (!dest.writable || dest.drive.orgId !== node.orgId) return FORBIDDEN;
  if (dest.chain.some((row) => row.id === node.id)) return { status: "cycle" };
  const from = driveOf(node);
  const crossing = !sameDrive(from, dest.drive);
  if (crossing) {
    const refusal = await leavingRefusal(tx, door, found);
    if (refusal) return refusal;
  }
  if (node.parentId === dest.parentId && !crossing) return { status: "ok", node: toNode(node) };
  if (
    node.kind === "folder" &&
    dest.depth + (await folderHeight(tx, node.id)) > STORAGE_MAX_DEPTH
  ) {
    return { status: "too_deep" };
  }
  if (crossing) {
    // Everything inside changes drive with it. The node itself changes in the one update below,
    // so it is never for a moment a sibling of the destination under its old name.
    await tx
      .update(storageNodes)
      .set({ space: dest.drive.space, ownerMemberId: dest.drive.ownerMemberId })
      .where(isInside(node.id));
  }
  const [moved] = await tx
    .update(storageNodes)
    .set({
      space: dest.drive.space,
      ownerMemberId: dest.drive.ownerMemberId,
      parentId: dest.parentId,
      name: freeName(dest.drive, dest.parentId, node.name, node.kind, node.id),
    })
    .where(eq(storageNodes.id, node.id))
    .returning();
  return moved ? { status: "ok", node: toNode(moved) } : NOT_FOUND;
}

/** What a member and a grantee can both do, each bounded by their door. */
export function treeOperations(db: Db, door: Door) {
  return {
    /** A node the door opens. A member also gets one that is in Trash (`node.trashedAt`). */
    async node(nodeId: string): Promise<StorageNodeView | null> {
      const found = await reach(db, door, nodeId);
      return found ? view(found.chain, found.access) : null;
    },

    /** The node carrying this link, when the door opens it whatever the link's own access is. */
    async nodeByShareId(shareId: string): Promise<StorageNodeView | null> {
      const [row] = await db
        .select({ id: storageNodes.id })
        .from(storageNodes)
        .where(eq(storageNodes.shareId, shareId));
      if (!row) return null;
      const found = await reach(db, door, row.id);
      return found && !inTrash(found.chain) ? view(found.chain, found.access) : null;
    },

    /** A folder's live contents: folders first, then by name. */
    async list(
      place: StoragePlace,
      page: { cursor?: StorageListCursor | null; limit?: number } = {},
    ): Promise<ListResult> {
      const at = await resolvePlace(db, door, place);
      if (!at) return NOT_FOUND;
      const { nodes, nextCursor } = await listChildren(db, at.drive, at.parentId, page);
      const folder = at.access ? view(at.chain, at.access) : null;
      return { status: "ok", folder, nodes, nextCursor };
    },

    /** A taken name gets a number instead of an error. */
    async createFolder(place: StoragePlace, name: string): Promise<CreateFolderResult> {
      const clean = cleanName(name);
      if (!clean) return { status: "invalid_name" };
      return db.transaction(async (tx) => {
        const first = await resolvePlace(tx, door, place);
        if (!first) return NOT_FOUND;
        // Resolved again under the lock: a move may have pushed the folder deeper meanwhile.
        await lockTree(tx, first.drive.orgId);
        const at = await resolvePlace(tx, door, place);
        if (!at) return NOT_FOUND;
        if (!at.writable) return FORBIDDEN;
        if (at.depth + 1 > STORAGE_MAX_DEPTH) return { status: "too_deep" as const };
        const actor = await door.actor(tx, at.drive.orgId);
        if (!actor) return FORBIDDEN;
        const row = await insertNode(tx, {
          drive: at.drive,
          parentId: at.parentId,
          kind: "folder",
          name: clean,
          createdByMemberId: actor,
        });
        return { status: "ok" as const, node: toNode(row) };
      });
    },

    /** Renaming to a name a sibling has is refused: the person typed it, so they choose again. */
    async rename(nodeId: string, name: string): Promise<RenameResult> {
      const clean = cleanName(name);
      if (!clean) return { status: "invalid_name" };
      try {
        return await db.transaction(async (tx): Promise<RenameResult> => {
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) return NOT_FOUND;
          // Under the tree lock, as a lock is taken: the guard below cannot see a lock row
          // another transaction has not committed yet, so a rename waits for it.
          await lockTree(tx, orgId);
          const found = await reach(tx, door, nodeId);
          if (!found || inTrash(found.chain)) return NOT_FOUND;
          if (!found.access.change) return FORBIDDEN;
          if (found.node.lockedAt) return LOCKED;
          const [row] = await tx
            .update(storageNodes)
            .set({ name: clean })
            .where(
              sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is null and not exists (select 1 from ${storageLocks} where ${storageLocks.nodeId} = ${storageNodes.id})`,
            )
            .returning();
          return row ? { status: "ok", node: toNode(row) } : NOT_FOUND;
        });
      } catch (error) {
        if (isUniqueViolation(error)) return { status: "name_taken" };
        throw error;
      }
    },

    /**
     * Moves a node into a folder or to a root of the same workspace. A name taken there gets a
     * number. A member may cross between My files and Shared; a grantee stays in one drive.
     */
    move(nodeId: string, to: StoragePlace): Promise<MoveResult> {
      return retryNameRace(() => db.transaction((tx) => moveInto(tx, door, nodeId, to)));
    },

    /**
     * Moves a node to Trash, with everything inside it. Trashing it again changes nothing. A
     * locked file, or a folder holding one at any depth, stays.
     */
    trash(nodeId: string): Promise<TrashResult> {
      return db.transaction(async (tx): Promise<TrashResult> => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND;
        // Under the tree lock, as a lock is taken: a file locked meanwhile is seen here.
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found) return NOT_FOUND;
        if (found.node.trashedAt) return { status: "ok", node: toNode(found.node) };
        if (inTrash(found.chain)) return NOT_FOUND;
        if (!found.access.remove || !(await door.removesWhole(tx, found.node))) return FORBIDDEN;
        if (await holdsLocked(tx, nodeId)) return LOCKED;
        const [row] = await tx
          .update(storageNodes)
          .set({ trashedAt: new Date() })
          .where(sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is null`)
          .returning();
        return { status: "ok", node: toNode(row ?? found.node) };
      });
    },

    /** A file and where its bytes are, for a download. */
    async file(nodeId: string): Promise<FileResult> {
      const found = await reach(db, door, nodeId);
      if (!found || found.node.kind !== "file" || !found.node.r2Key) return NOT_FOUND;
      return { status: "ok", file: toNode(found.node), r2Key: found.node.r2Key };
    },
  };
}
