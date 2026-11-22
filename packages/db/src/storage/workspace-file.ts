import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageNodes } from "../schema/storage.ts";

/**
 * A file's object in R2, read for its workspace rather than for a person: for a module that
 * already decided who may read it (a meeting's recording, by the meeting's grants). Null when the
 * node is not a live file of that workspace. Never call it from a member's request without that
 * check.
 */
export async function workspaceFile(db: Db, orgId: string, nodeId: string) {
  const [row] = await db
    .select({
      id: storageNodes.id,
      name: storageNodes.name,
      size: storageNodes.size,
      mimeType: storageNodes.mimeType,
      r2Key: storageNodes.r2Key,
      ownerMemberId: storageNodes.ownerMemberId,
      space: storageNodes.space,
    })
    .from(storageNodes)
    .where(
      and(
        eq(storageNodes.id, nodeId),
        eq(storageNodes.orgId, orgId),
        eq(storageNodes.kind, "file"),
        isNull(storageNodes.trashedAt),
      ),
    );
  return row?.r2Key ? { ...row, r2Key: row.r2Key } : null;
}
