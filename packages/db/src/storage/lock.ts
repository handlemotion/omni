import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes } from "../schema/storage.ts";
import { loadMember, type Door } from "./access.ts";
import { lockTree, orgOfNode, toNode } from "./core.ts";
import { nextRevision } from "./revision.ts";
import { keepUpdatedAt, reachLive, type NodeResult } from "./tree.ts";
import { NOT_FOUND, FORBIDDEN } from "./results.ts";

async function bump(tx: Db, orgId: string, nodeId: string) {
  const revision = await nextRevision(tx, orgId);
  await tx
    .update(storageNodes)
    .set({ revision, updatedAt: keepUpdatedAt })
    .where(eq(storageNodes.id, nodeId));
  return revision;
}

export type StorageLockResult = NodeResult | { status: "not_a_file" };

export function lockOperations(db: Db, door: Door, memberId: string) {
  return {
    lock(nodeId: string) {
      return db.transaction<StorageLockResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies StorageLockResult;
        await lockTree(tx, orgId);
        const found = await reachLive(tx, door, nodeId);
        if (!found) return NOT_FOUND satisfies StorageLockResult;
        if (!found.access.change) return FORBIDDEN satisfies StorageLockResult;
        if (found.node.kind !== "file") return { status: "not_a_file" } satisfies StorageLockResult;
        if (found.node.lockedAt)
          return { status: "ok", node: toNode(found.node) } satisfies StorageLockResult;
        const [row] = await tx
          .insert(storageLocks)
          .values({ nodeId, orgId, lockedAt: new Date(), lockedByMemberId: memberId })
          .onConflictDoNothing()
          .returning({ lockedAt: storageLocks.lockedAt });
        const lockedAt = row?.lockedAt ?? found.node.lockedAt ?? new Date();
        const revision = row ? await bump(tx, orgId, nodeId) : found.node.revision;
        return {
          status: "ok",
          node: toNode({ ...found.node, lockedAt, revision }),
        } satisfies StorageLockResult;
      });
    },

    unlock(nodeId: string) {
      return db.transaction<NodeResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies NodeResult;
        await lockTree(tx, orgId);
        const found = await reachLive(tx, door, nodeId);
        if (!found) return NOT_FOUND satisfies NodeResult;
        const member = await loadMember(tx, memberId);
        if (!member?.admin) return FORBIDDEN satisfies NodeResult;
        const removed = await tx
          .delete(storageLocks)
          .where(eq(storageLocks.nodeId, nodeId))
          .returning({ nodeId: storageLocks.nodeId });
        const revision = removed.length > 0 ? await bump(tx, orgId, nodeId) : found.node.revision;
        return {
          status: "ok",
          node: toNode({ ...found.node, lockedAt: null, revision }),
        } satisfies NodeResult;
      });
    },
  };
}
