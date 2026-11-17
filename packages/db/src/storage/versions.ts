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
/**
 * A checked save whose base is no longer the file's content: `contentVersion` is the file's now,
 * so the editor can fetch it, merge, and save again on top of it.
 */
export type StaleContent = { status: "version_conflict"; contentVersion: number };

/** Refuses a save based on another content than the file's current one. Null: unchecked. */
export const staleFor = (node: NodeRow, base: number | null | undefined) =>
  (base !== null && base !== undefined && node.contentVersion !== base
    ? { status: "version_conflict", contentVersion: node.contentVersion }
    : null) satisfies StaleContent | null;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

async function currentWriter(ex: Db, node: NodeRow) {
  const [row] = await ex
    .select({
      writtenByMemberId: storageContents.writtenByMemberId,
      writtenAt: storageContents.writtenAt,
    })
    .from(storageContents)
    .where(eq(storageContents.nodeId, node.id));
  return row ?? { writtenByMemberId: node.createdByMemberId, writtenAt: node.createdAt };
}

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

async function editable(ex: Db, door: Door, nodeId: string) {
  const found = await reach(ex, door, nodeId);
  if (!found || found.node.kind !== "file" || !found.node.r2Key || inTrash(found.chain)) {
    return NOT_FOUND;
  }
  if (!editsContent(found.access)) return FORBIDDEN;
  return { status: "ok", node: found.node, r2Key: found.node.r2Key } as const;
}

async function keepCurrent(tx: Db, node: NodeRow, r2Key: string) {
  await tx.insert(storageVersions).values({
    orgId: node.orgId,
    nodeId: node.id,
    size: node.size,
    mimeType: node.mimeType,
    r2Key,
    contentVersion: node.contentVersion,
    ...(await currentWriter(tx, node)),
  });
}

/**
 * Makes an uploaded object the file's content and keeps what it replaces. Call with the tree
 * locked. The caller counts the new bytes: the replaced ones stay stored, as a version.
 */
export const replaceContent: (
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
  base?: number | null,
) => Promise<NodeResult | Locked | StaleContent> = async (
  tx,
  door,
  nodeId,
  content,
  base = null,
) => {
  const found = await editable(tx, door, nodeId);
  if (found.status !== "ok") return found;
  if (found.node.lockedAt) return LOCKED;
  const stale = staleFor(found.node, base);
  if (stale) return stale;
  await keepCurrent(tx, found.node, found.r2Key);
  return setContent(tx, found.node, {
    ...content,
    writtenByMemberId: content.memberId,
    writtenAt: new Date(),
  });
};

/** Whether the door's holder may write a new version of the file: what an upload to it needs. */
export async function mayReplace(ex: Db, door: Door, nodeId: string) {
  const found = await editable(ex, door, nodeId);
  if (found.status !== "ok") return found;
  return found.node.lockedAt ? LOCKED : found;
}

export function versionOperations(db: Db, door: Door) {
  return {
    async versions(nodeId: string) {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return found satisfies VersionsResult;
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
      } satisfies VersionsResult;
    },

    async versionFile(nodeId: string, versionId: string) {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return NOT_FOUND satisfies FileResult;
      const [version] = await db
        .select()
        .from(storageVersions)
        .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)));
      if (!version) return NOT_FOUND satisfies FileResult;
      const file = { ...toNode(found.node), size: version.size, mimeType: version.mimeType };
      return { status: "ok", file, r2Key: version.r2Key } satisfies FileResult;
    },

    restoreVersion(nodeId: string, versionId: string) {
      return db.transaction<RestoreVersionResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies RestoreVersionResult;
        await lockTree(tx, orgId);
        await lockUsage(tx, orgId);
        const found = await editable(tx, door, nodeId);
        if (found.status !== "ok") return found satisfies RestoreVersionResult;
        if (found.node.lockedAt) return LOCKED satisfies RestoreVersionResult;
        const [version] = await tx
          .delete(storageVersions)
          .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)))
          .returning();
        if (!version) return NOT_FOUND satisfies RestoreVersionResult;
        await keepCurrent(tx, found.node, found.r2Key);
        return setContent(tx, found.node, {
          ...version,
          sha256: null,
        }) satisfies Promise<RestoreVersionResult>;
      });
    },
  };
}
