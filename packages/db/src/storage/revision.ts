// The sync revision (ADR 0043): every change to a node takes the workspace's next revision in its
// own transaction, and a node leaving a drive for good leaves a tombstone there. `sync.ts` reads
// both back as a drive's change feed.
import { sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { storageNodes, storageSyncState, storageTombstones } from "../schema/storage.ts";

/**
 * The next revision of the workspace. The counter row stays locked until the caller's
 * transaction ends, so take it last, after the tree, usage and upload locks.
 */
export async function nextRevision(tx: Db, orgId: string) {
  const [row] = await tx
    .insert(storageSyncState)
    .values({ orgId, revision: 1 })
    .onConflictDoUpdate({
      target: storageSyncState.orgId,
      set: { revision: sql`${storageSyncState.revision} + 1` },
    })
    .returning({ revision: storageSyncState.revision });
  return row!.revision;
}

/**
 * Records that the nodes matching `where` leave the drive they are in now, at `revision`. Call
 * before the update or delete that takes them out.
 */
export async function leaveTombstones(tx: Db, where: SQL | undefined, revision: number) {
  const leaving = await tx
    .select({
      orgId: storageNodes.orgId,
      nodeId: storageNodes.id,
      space: storageNodes.space,
      ownerMemberId: storageNodes.ownerMemberId,
    })
    .from(storageNodes)
    .where(where);
  for (let at = 0; at < leaving.length; at += 1000) {
    await tx
      .insert(storageTombstones)
      .values(leaving.slice(at, at + 1000).map((row) => ({ id: uuidv7(), ...row, revision })));
  }
}
