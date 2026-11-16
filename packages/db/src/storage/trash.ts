// Trash (ADR 0034 decision 5), for members only: a grant or a link opens nothing in it. A node
// can be restored for 30 days, then the daily purge deletes it; "Delete forever" does so at once.
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageNodes } from "../schema/storage.ts";
import { loadMember, type Door } from "./access.ts";
import {
  deleteSubtree,
  driveOf,
  freeName,
  holdsLocked,
  lockTree,
  orgOfNode,
  pageSize,
  toNode,
  type StorageNode,
} from "./core.ts";
import {
  LOCKED,
  reach,
  retryNameRace,
  type Forbidden,
  type Locked,
  type NodeResult,
  type NotFound,
} from "./tree.ts";

/** Days a trashed node can still be restored. */
export const STORAGE_TRASH_DAYS = 30;

export interface StorageTrashCursor {
  trashedAt: Date;
  id: string;
}

export type RestoreResult =
  | NodeResult
  /** The folder it was in is in Trash too: restore that one. */
  | { status: "parent_trashed" };

export type DeleteForeverResult =
  /** The rows are gone and the bytes subtracted; the caller now deletes these objects. */
  | { status: "ok"; r2Keys: string[] }
  | NotFound
  | Forbidden
  | Locked
  /** Only what is in Trash is deleted for good. */
  | { status: "not_trashed" };

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

export function trashOperations(db: Db, door: Door, memberId: string) {
  return {
    /**
     * What the member may restore, newest first: their own trashed My files and, in Shared, what
     * they uploaded, or everything for an owner or admin.
     */
    async listTrash(page: { cursor?: StorageTrashCursor | null; limit?: number } = {}) {
      const member = await loadMember(db, memberId);
      if (!member) return { nodes: [] as StorageNode[], nextCursor: null };
      const limit = pageSize(page.limit);
      const mine = and(
        eq(storageNodes.space, "personal"),
        eq(storageNodes.ownerMemberId, member.id),
      );
      const shared = and(
        eq(storageNodes.space, "shared"),
        member.admin ? undefined : eq(storageNodes.createdByMemberId, member.id),
      );
      const after = page.cursor
        ? or(
            lt(storageNodes.trashedAt, page.cursor.trashedAt),
            and(
              eq(storageNodes.trashedAt, page.cursor.trashedAt),
              lt(storageNodes.id, page.cursor.id),
            ),
          )
        : undefined;
      const rows = await db
        .select()
        .from(storageNodes)
        .where(
          and(
            eq(storageNodes.orgId, member.orgId),
            isNotNull(storageNodes.trashedAt),
            member.personal ? mine : or(mine, shared),
            after,
          ),
        )
        .orderBy(desc(storageNodes.trashedAt), desc(storageNodes.id))
        .limit(limit + 1);
      const nodes = rows.slice(0, limit);
      const last = nodes.at(-1);
      const nextCursor: StorageTrashCursor | null =
        rows.length > limit && last?.trashedAt ? { trashedAt: last.trashedAt, id: last.id } : null;
      return { nodes: nodes.map(toNode), nextCursor };
    },

    /** Puts a trashed node back where it was. A name taken meanwhile gets a number. */
    restore(nodeId: string): Promise<RestoreResult> {
      return retryNameRace(() =>
        db.transaction(async (tx): Promise<RestoreResult> => {
          // Under the tree lock, like a permanent delete: a restore that slipped in after the
          // delete had seen the node in Trash would report success for a file about to go.
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) return NOT_FOUND;
          await lockTree(tx, orgId);
          const found = await reach(tx, door, nodeId);
          if (!found || !found.node.trashedAt) return NOT_FOUND;
          if (!found.access.remove) return FORBIDDEN;
          if (found.chain.slice(1).some((row) => row.trashedAt)) {
            return { status: "parent_trashed" };
          }
          const { node } = found;
          const [row] = await tx
            .update(storageNodes)
            .set({
              trashedAt: null,
              name: freeName(driveOf(node), node.parentId, node.name, node.kind, node.id),
            })
            .where(sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is not null`)
            .returning();
          return row ? { status: "ok", node: toNode(row) } : NOT_FOUND;
        }),
      );
    },

    /** Deletes a trashed node and everything inside it, rows first. */
    deleteForever(nodeId: string): Promise<DeleteForeverResult> {
      return db.transaction(async (tx): Promise<DeleteForeverResult> => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND;
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found) return NOT_FOUND;
        // A locked file is never in Trash; it says why it cannot go rather than where it is.
        if (await holdsLocked(tx, nodeId)) return LOCKED;
        if (!found.node.trashedAt) return { status: "not_trashed" };
        if (!found.access.remove || !(await door.removesWhole(tx, found.node))) return FORBIDDEN;
        const { r2Keys } = await deleteSubtree(tx, orgId, nodeId);
        return { status: "ok", r2Keys };
      });
    },
  };
}
