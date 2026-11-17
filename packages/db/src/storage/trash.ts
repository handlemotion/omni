import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageNodes } from "../schema/storage.ts";
import { loadMember, type Door } from "./access.ts";
import {
  deleteSubtree,
  driveOf,
  freeName,
  holdsLocked,
  isInside,
  lockTree,
  orgOfNode,
  pageSize,
  toNode,
  type Drive,
  type StorageNode,
} from "./core.ts";
import { nextRevision } from "./revision.ts";
import {
  keepUpdatedAt,
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

export type RestoreResult = NodeResult | { status: "parent_trashed" };

export type DeleteForeverResult =
  | { status: "ok"; r2Keys: string[]; drive: Drive }
  | NotFound
  | Forbidden
  | Locked
  | { status: "not_trashed" };

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

export function trashOperations(db: Db, door: Door, memberId: string) {
  return {
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

    restore(nodeId: string) {
      return retryNameRace(() =>
        db.transaction(async (tx) => {
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) return NOT_FOUND satisfies RestoreResult;
          await lockTree(tx, orgId);
          const found = await reach(tx, door, nodeId);
          if (!found || !found.node.trashedAt) return NOT_FOUND satisfies RestoreResult;
          if (!found.access.remove) return FORBIDDEN satisfies RestoreResult;
          if (found.chain.slice(1).some((row) => row.trashedAt)) {
            return { status: "parent_trashed" } satisfies RestoreResult;
          }
          const { node } = found;
          const revision = await nextRevision(tx, orgId);
          await tx
            .update(storageNodes)
            .set({ revision, updatedAt: keepUpdatedAt })
            .where(isInside(nodeId));
          const [row] = await tx
            .update(storageNodes)
            .set({
              revision,
              trashedAt: null,
              name: freeName(driveOf(node), node.parentId, node.name, node.kind, node.id),
            })
            .where(sql`${storageNodes.id} = ${nodeId} and ${storageNodes.trashedAt} is not null`)
            .returning();
          return (row ? { status: "ok", node: toNode(row) } : NOT_FOUND) satisfies RestoreResult;
        }),
      ) satisfies Promise<RestoreResult>;
    },

    deleteForever(nodeId: string) {
      return db.transaction<DeleteForeverResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies DeleteForeverResult;
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found) return NOT_FOUND satisfies DeleteForeverResult;
        if (await holdsLocked(tx, nodeId)) return LOCKED satisfies DeleteForeverResult;
        if (!found.node.trashedAt) return { status: "not_trashed" } satisfies DeleteForeverResult;
        if (!found.access.remove || !(await door.removesWhole(tx, found.node)))
          return FORBIDDEN satisfies DeleteForeverResult;
        const { r2Keys } = await deleteSubtree(tx, orgId, nodeId);
        return { status: "ok", r2Keys, drive: driveOf(found.node) } satisfies DeleteForeverResult;
      });
    },
  };
}
