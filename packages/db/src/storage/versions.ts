// A file's versions (ADR 0043 decision 1). New content replaces a file's current content, which
// is kept as a row in `storage_versions` for 30 days; restoring one swaps it back. No bytes move:
// a version is an object of its own. A new version arrives as an upload (`uploads.ts`), which
// calls `replaceContent` when it completes.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { storageContents, storageNodes, storageVersions } from "../schema/storage.ts";
import { editsContent, type Door } from "./access.ts";
import {
  inTrash,
  lockTree,
  lockUsage,
  orgOfNode,
  toNode,
  type NodeRow,
  type StorageNode,
} from "./core.ts";
import { nextRevision } from "./revision.ts";
import { LOCKED, reach, type FileResult, type Locked, type NodeResult } from "./tree.ts";

/** A replaced version is kept this long, then deleted for good. */
export const STORAGE_VERSION_DAYS = 30;

/** Content a file has or had. `writtenByName` is null once its writer is gone. */
export interface StorageContent {
  size: number;
  mimeType: string | null;
  writtenAt: Date;
  writtenByName: string | null;
}

export interface StorageVersion extends StorageContent {
  id: string;
  replacedAt: Date;
}

export type VersionsResult =
  | { status: "ok"; node: StorageNode; current: StorageContent; versions: StorageVersion[] }
  | { status: "not_found" }
  | { status: "forbidden" };
export type RestoreVersionResult = NodeResult | Locked;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

/** Who wrote a file's current content, and when: its creator, until a version replaced it. */
async function currentWriter(ex: Db, node: NodeRow) {
  const [row] = await ex
    .select({
      writtenByMemberId: storageContents.writtenByMemberId,
      writtenAt: storageContents.writtenAt,
    })
    .from(storageContents)
    .where(eq(storageContents.nodeId, node.id));
  // A replaced content whose writer is gone has no writer; it is not the file's creator's.
  return row ?? { writtenByMemberId: node.createdByMemberId, writtenAt: node.createdAt };
}

/**
 * Points the file at other content, and records who wrote that content and when. The file takes
 * the workspace's next revision and its `contentVersion` goes up, so a sync client reads it as
 * changed bytes (ADR 0043). `sha256` is the new bytes' hash when known; a restored version's is
 * not kept, so it is null.
 */
async function setContent(
  tx: Db,
  node: NodeRow,
  content: {
    size: number;
    mimeType: string | null;
    r2Key: string;
    sha256: string | null;
    writtenByMemberId: string | null;
    writtenAt: Date;
  },
) {
  const { writtenByMemberId, writtenAt } = content;
  await tx
    .insert(storageContents)
    .values({ nodeId: node.id, orgId: node.orgId, writtenByMemberId, writtenAt })
    .onConflictDoUpdate({
      target: storageContents.nodeId,
      set: { writtenByMemberId, writtenAt },
    });
  // Last, after the tree and usage locks the caller holds: the counter stays locked to commit.
  const revision = await nextRevision(tx, node.orgId);
  const [row] = await tx
    .update(storageNodes)
    .set({
      size: content.size,
      mimeType: content.mimeType,
      r2Key: content.r2Key,
      contentSha256: content.sha256,
      contentVersion: sql`${storageNodes.contentVersion} + 1`,
      revision,
    })
    .where(eq(storageNodes.id, node.id))
    .returning();
  return row ? ({ status: "ok", node: toNode(row) } as const) : NOT_FOUND;
}

async function nameOf(ex: Db, memberId: string | null) {
  if (!memberId) return null;
  const [row] = await ex
    .select({ name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.id, memberId));
  return row?.name ?? null;
}

/** A live file whose content the door's holder may replace, or why not. */
async function editable(ex: Db, door: Door, nodeId: string) {
  const found = await reach(ex, door, nodeId);
  if (!found || found.node.kind !== "file" || !found.node.r2Key || inTrash(found.chain)) {
    return NOT_FOUND;
  }
  if (!editsContent(found.access)) return FORBIDDEN;
  return { status: "ok", node: found.node, r2Key: found.node.r2Key } as const;
}

/** Keeps the node's current content as a version. Call before pointing the node elsewhere. */
async function keepCurrent(tx: Db, node: NodeRow, r2Key: string) {
  await tx.insert(storageVersions).values({
    orgId: node.orgId,
    nodeId: node.id,
    size: node.size,
    mimeType: node.mimeType,
    r2Key,
    ...(await currentWriter(tx, node)),
  });
}

/**
 * Makes an uploaded object the file's content and keeps what it replaces. Call with the tree
 * locked. The caller counts the new bytes: the replaced ones stay stored, as a version.
 */
export async function replaceContent(
  tx: Db,
  door: Door,
  nodeId: string,
  content: {
    size: number;
    mimeType: string | null;
    r2Key: string;
    sha256: string | null;
    memberId: string;
  },
): Promise<NodeResult | Locked> {
  const found = await editable(tx, door, nodeId);
  if (found.status !== "ok") return found;
  if (found.node.lockedAt) return LOCKED;
  await keepCurrent(tx, found.node, found.r2Key);
  return setContent(tx, found.node, {
    ...content,
    writtenByMemberId: content.memberId,
    writtenAt: new Date(),
  });
}

/** Whether the door's holder may write a new version of the file: what an upload to it needs. */
export async function mayReplace(ex: Db, door: Door, nodeId: string) {
  const found = await editable(ex, door, nodeId);
  if (found.status !== "ok") return found;
  return found.node.lockedAt ? LOCKED : found;
}

export function versionOperations(db: Db, door: Door) {
  return {
    /** The file's current content and the versions it replaced, newest first. */
    async versions(nodeId: string): Promise<VersionsResult> {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return found;
      const rows = await db
        .select({
          id: storageVersions.id,
          size: storageVersions.size,
          mimeType: storageVersions.mimeType,
          writtenAt: storageVersions.writtenAt,
          replacedAt: storageVersions.replacedAt,
          writtenByName: users.name,
        })
        .from(storageVersions)
        .leftJoin(members, eq(members.id, storageVersions.writtenByMemberId))
        .leftJoin(users, eq(users.id, members.userId))
        .where(eq(storageVersions.nodeId, nodeId))
        .orderBy(desc(storageVersions.replacedAt), desc(storageVersions.id));
      const writer = await currentWriter(db, found.node);
      return {
        status: "ok",
        node: toNode(found.node),
        current: {
          size: found.node.size,
          mimeType: found.node.mimeType,
          writtenAt: writer.writtenAt,
          writtenByName: await nameOf(db, writer.writtenByMemberId),
        },
        versions: rows,
      };
    },

    /** A kept version and where its bytes are, for a download under the file's name. */
    async versionFile(nodeId: string, versionId: string): Promise<FileResult> {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return NOT_FOUND;
      const [version] = await db
        .select()
        .from(storageVersions)
        .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)));
      if (!version) return NOT_FOUND;
      const file = { ...toNode(found.node), size: version.size, mimeType: version.mimeType };
      return { status: "ok", file, r2Key: version.r2Key };
    },

    /**
     * Makes a kept version the file's content again; the content it displaces becomes a
     * version, kept 30 days from now. The workspace stores the same bytes before and after.
     */
    restoreVersion(nodeId: string, versionId: string): Promise<RestoreVersionResult> {
      return db.transaction(async (tx): Promise<RestoreVersionResult> => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND;
        // Under the tree lock, as a lock is taken and a new version lands; then the usage lock,
        // so the daily recount never sums the nodes before the swap and the versions after it.
        await lockTree(tx, orgId);
        await lockUsage(tx, orgId);
        const found = await editable(tx, door, nodeId);
        if (found.status !== "ok") return found;
        if (found.node.lockedAt) return LOCKED;
        const [version] = await tx
          .delete(storageVersions)
          .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)))
          .returning();
        if (!version) return NOT_FOUND;
        await keepCurrent(tx, found.node, found.r2Key);
        return setContent(tx, found.node, { ...version, sha256: null });
      });
    },
  };
}
