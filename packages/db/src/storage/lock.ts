// The file lock (ADR 0036 decision 6), for members only. A locked file cannot be renamed, moved,
// trashed or deleted for good, and a folder holding one cannot be trashed: `tree.ts` and
// `trash.ts` refuse those with `locked`. A lock is a row in `storage_locks`. Storage does not know
// why a file is locked; a caller such as a signed contract does. Deleting the workspace still
// deletes locked files: the lock cascades with its node.
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageLocks, storageNodes } from "../schema/storage.ts";
import { loadMember, type Door } from "./access.ts";
import { inTrash, lockTree, orgOfNode, toNode } from "./core.ts";
import { nextRevision } from "./revision.ts";
import { keepUpdatedAt, reach, type NodeResult } from "./tree.ts";

/** A lock taken or lifted changes what a sync client may do with the file: a new revision. */
async function bump(tx: Db, orgId: string, nodeId: string) {
  const revision = await nextRevision(tx, orgId);
  await tx
    .update(storageNodes)
    .set({ revision, updatedAt: keepUpdatedAt })
    .where(eq(storageNodes.id, nodeId));
  return revision;
}

export type StorageLockResult =
  | NodeResult
  /** Only a file is locked. */
  | { status: "not_a_file" };

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

export function lockOperations(db: Db, door: Door, memberId: string) {
  return {
    /**
     * Locks a live file the member reaches. Locking it again changes nothing and keeps who
     * locked it first. To lock in the same transaction as another write, call it on the member
     * door opened with that transaction: `forMember(tx, memberId).storage.lock(nodeId)`.
     */
    lock(nodeId: string): Promise<StorageLockResult> {
      return db.transaction(async (tx): Promise<StorageLockResult> => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND;
        // The tree lock orders it with a trash or move that checked for locked files.
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found || inTrash(found.chain)) return NOT_FOUND;
        if (!found.access.change) return FORBIDDEN;
        if (found.node.kind !== "file") return { status: "not_a_file" };
        if (found.node.lockedAt) return { status: "ok", node: toNode(found.node) };
        const [row] = await tx
          .insert(storageLocks)
          .values({ nodeId, orgId, lockedAt: new Date(), lockedByMemberId: memberId })
          .onConflictDoNothing()
          .returning({ lockedAt: storageLocks.lockedAt });
        const lockedAt = row?.lockedAt ?? found.node.lockedAt ?? new Date();
        const revision = row ? await bump(tx, orgId, nodeId) : found.node.revision;
        return { status: "ok", node: toNode({ ...found.node, lockedAt, revision }) };
      });
    },

    /** Makes it an ordinary file again. Owners and admins only; unlocking twice is fine. */
    unlock(nodeId: string): Promise<NodeResult> {
      return db.transaction(async (tx): Promise<NodeResult> => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND;
        await lockTree(tx, orgId);
        const found = await reach(tx, door, nodeId);
        if (!found || inTrash(found.chain)) return NOT_FOUND;
        const member = await loadMember(tx, memberId);
        if (!member?.admin) return FORBIDDEN;
        const removed = await tx
          .delete(storageLocks)
          .where(eq(storageLocks.nodeId, nodeId))
          .returning({ nodeId: storageLocks.nodeId });
        const revision = removed.length > 0 ? await bump(tx, orgId, nodeId) : found.node.revision;
        return { status: "ok", node: toNode({ ...found.node, lockedAt: null, revision }) };
      });
    },
  };
}
