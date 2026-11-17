import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { storageUploads, storageUploadTargets, type StorageUploadPart } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import {
  addUsage,
  cleanName,
  insertNode,
  lockTree,
  lockUsage,
  storageObjectKey,
  toNode,
  type StorageNode,
} from "./core.ts";
import {
  reach,
  resolvePlace,
  type Forbidden,
  type InvalidName,
  type Locked,
  type NotFound,
  type StoragePlace,
} from "./tree.ts";
import { mayReplace, replaceContent, staleFor, type StaleContent } from "./versions.ts";

/** An upload nobody completes is aborted after this long. */
export const STORAGE_UPLOAD_TTL_MS = 24 * 60 * 60_000;

export type StorageUpload = typeof storageUploads.$inferSelect;

/** The workspace has no room for the file. Trashed files and uploads in progress count. */
export interface StorageFull {
  status: "full";
  usedBytes: number;
  /** Declared sizes of the other uploads in progress. */
  reservedBytes: number;
  limitBytes: number;
}

export type OpenUploadResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | Forbidden
  | InvalidName
  | StorageFull;

export type OpenVersionUploadResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | Forbidden
  | Locked
  | StaleContent
  | StorageFull;

export type RecordPartResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | { status: "too_large" };

export type CompleteUploadResult =
  | { status: "ok"; node: StorageNode; r2Key: string; created: boolean }
  | NotFound
  | Forbidden
  | { status: "incomplete" }
  | Locked
  | StaleContent
  | StorageFull;

export type AbortUploadResult =
  | { status: "ok"; r2Key: string; r2UploadId: string | null }
  | NotFound;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

/** Declared bytes of a workspace's uploads in progress, optionally leaving one out. */
export async function reservedBytes(ex: Db, orgId: string, exceptUploadId?: string) {
  const [row] = await ex
    .select({ bytes: sql<string>`coalesce(sum(${storageUploads.size}), 0)` })
    .from(storageUploads)
    .where(
      and(
        eq(storageUploads.orgId, orgId),
        isNull(storageUploads.nodeId),
        gt(storageUploads.expiresAt, new Date()),
        exceptUploadId ? sql`${storageUploads.id} <> ${exceptUploadId}` : undefined,
      ),
    );
  return Number(row?.bytes ?? 0);
}

async function targetOf(ex: Db, uploadId: string) {
  const [row] = await ex
    .select({
      nodeId: storageUploadTargets.nodeId,
    })
    .from(storageUploadTargets)
    .where(eq(storageUploadTargets.uploadId, uploadId));
  return row ?? null;
}

const live = (upload: StorageUpload) => !upload.nodeId && upload.expiresAt > new Date();

export function uploadOperations(db: Db, door: Door) {
  async function mine(ex: Db, uploadId: string, lock = false) {
    const query = ex.select().from(storageUploads).where(eq(storageUploads.id, uploadId));
    const [upload] = await (lock ? query.for("update") : query);
    if (!upload || !(await door.ownsUpload(ex, upload.memberId))) return null;
    if (upload.nodeId || door.kind !== "grant") return upload;
    const target = await targetOf(ex, upload.id);
    if (target) {
      if (!target.nodeId) return null;
      return (await mayReplace(ex, door, target.nodeId)).status === "ok" ? upload : null;
    }
    const at = await resolvePlace(
      ex,
      door,
      upload.parentId ? { parentId: upload.parentId } : { space: upload.space },
    );
    return at?.writable ? upload : null;
  }

  async function fullFor(
    tx: Db,
    orgId: string,
    usedBytes: number,
    size: number,
    limit: number | null,
  ) {
    if (limit === null) return null;
    const reserved = await reservedBytes(tx, orgId);
    if (usedBytes + reserved + size <= limit) return null;
    return { status: "full", usedBytes, reservedBytes: reserved, limitBytes: limit } as const;
  }

  return {
    async openUpload(
      place: StoragePlace,
      file: {
        name: string;
        size: number;
        mimeType?: string | null;
        limitBytes: number | null;
        sha256?: string | null;
      },
    ) {
      const name = cleanName(file.name);
      if (!name) return { status: "invalid_name" } satisfies OpenUploadResult;
      return db.transaction<OpenUploadResult>(async (tx) => {
        const at = await resolvePlace(tx, door, place);
        if (!at) {
          const result: OpenUploadResult = NOT_FOUND;
          return result;
        }
        if (!at.writable) {
          const result: OpenUploadResult = FORBIDDEN;
          return result;
        }
        const { orgId } = at.drive;
        const actor = await door.actor(tx, orgId);
        if (!actor) {
          const result: OpenUploadResult = FORBIDDEN;
          return result;
        }
        const usedBytes = await lockUsage(tx, orgId);
        const full = await fullFor(tx, orgId, usedBytes, file.size, file.limitBytes);
        if (full) {
          const result: OpenUploadResult = full;
          return result;
        }
        const id = uuidv7();
        const [upload] = await tx
          .insert(storageUploads)
          .values({
            id,
            orgId,
            memberId: actor,
            space: at.drive.space,
            parentId: at.parentId,
            name,
            size: file.size,
            mimeType: file.mimeType ?? null,
            sha256: file.sha256 ?? null,
            r2Key: storageObjectKey(orgId, id),
            expiresAt: new Date(Date.now() + STORAGE_UPLOAD_TTL_MS),
          })
          .returning();
        const result: OpenUploadResult = { status: "ok", upload: upload! };
        return result;
      });
    },

    async openVersionUpload(
      nodeId: string,
      file: {
        size: number;
        mimeType?: string | null;
        limitBytes: number | null;
        sha256?: string | null;
        ifContentVersion?: number | null;
      },
    ) {
      return db.transaction<OpenVersionUploadResult>(async (tx) => {
        const found = await mayReplace(tx, door, nodeId);
        if (found.status !== "ok") return found satisfies OpenVersionUploadResult;
        const { node } = found;
        const stale = staleFor(node, file.ifContentVersion);
        if (stale) return stale satisfies OpenVersionUploadResult;
        const actor = await door.actor(tx, node.orgId);
        if (!actor) return FORBIDDEN satisfies OpenVersionUploadResult;
        const usedBytes = await lockUsage(tx, node.orgId);
        const full = await fullFor(tx, node.orgId, usedBytes, file.size, file.limitBytes);
        if (full) return full satisfies OpenVersionUploadResult;
        const id = uuidv7();
        const [upload] = await tx
          .insert(storageUploads)
          .values({
            id,
            orgId: node.orgId,
            memberId: actor,
            space: node.space,
            parentId: node.parentId,
            name: node.name,
            size: file.size,
            mimeType: file.mimeType ?? null,
            sha256: file.sha256 ?? null,
            r2Key: storageObjectKey(node.orgId, id),
            expiresAt: new Date(Date.now() + STORAGE_UPLOAD_TTL_MS),
          })
          .returning();
        await tx
          .insert(storageUploadTargets)
          .values({ uploadId: id, orgId: node.orgId, nodeId: node.id });
        return { status: "ok", upload: upload! } satisfies OpenVersionUploadResult;
      });
    },

    async upload(uploadId: string) {
      return mine(db, uploadId) satisfies Promise<StorageUpload | null>;
    },

    async startUpload(uploadId: string, r2UploadId: string) {
      const upload = await mine(db, uploadId);
      if (!upload || !live(upload)) return null satisfies StorageUpload | null;
      const [row] = await db
        .update(storageUploads)
        .set({ r2UploadId })
        .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.r2UploadId)))
        .returning();
      return (row ??
        (upload.r2UploadId === r2UploadId ? upload : null)) satisfies StorageUpload | null;
    },

    recordUploadPart(uploadId: string, part: StorageUploadPart) {
      return db.transaction<RecordPartResult>(async (tx) => {
        const upload = await mine(tx, uploadId, true);
        if (!upload || !live(upload)) return NOT_FOUND satisfies RecordPartResult;
        const parts = [
          ...upload.parts.filter((other) => other.partNumber !== part.partNumber),
          part,
        ].toSorted((a, b) => a.partNumber - b.partNumber);
        if (parts.reduce((sum, each) => sum + each.size, 0) > upload.size) {
          return { status: "too_large" } satisfies RecordPartResult;
        }
        const [row] = await tx
          .update(storageUploads)
          .set({ parts })
          .where(eq(storageUploads.id, uploadId))
          .returning();
        return { status: "ok", upload: row! } satisfies RecordPartResult;
      });
    },

    async completeUpload(
      uploadId: string,
      options: {
        limitBytes: number | null;
        ifContentVersion?: number | null;
      },
    ) {
      const seen = await mine(db, uploadId);
      if (!seen) return NOT_FOUND satisfies CompleteUploadResult;
      return db.transaction<CompleteUploadResult>(async (tx) => {
        await lockTree(tx, seen.orgId);
        const usedBytes = await lockUsage(tx, seen.orgId);
        const upload = await mine(tx, uploadId, true);
        if (!upload) return NOT_FOUND satisfies CompleteUploadResult;
        if (upload.nodeId) {
          const found = await reach(tx, door, upload.nodeId);
          return (
            found
              ? { status: "ok", node: toNode(found.node), r2Key: upload.r2Key, created: false }
              : NOT_FOUND
          ) satisfies CompleteUploadResult;
        }
        if (!live(upload)) return NOT_FOUND satisfies CompleteUploadResult;
        if (upload.parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
          return { status: "incomplete" } satisfies CompleteUploadResult;
        }
        const { limitBytes } = options;
        const full = async () => {
          if (limitBytes === null || usedBytes + upload.size <= limitBytes)
            return null satisfies StorageFull | null;
          const reserved = await reservedBytes(tx, upload.orgId, upload.id);
          return {
            status: "full",
            usedBytes,
            reservedBytes: reserved,
            limitBytes,
          } satisfies StorageFull | null;
        };
        const target = await targetOf(tx, upload.id);
        if (target) {
          if (!target.nodeId) return NOT_FOUND satisfies CompleteUploadResult;
          const replaced =
            (await full()) ??
            (await replaceContent(tx, door, target.nodeId, upload, options.ifContentVersion));
          if (replaced.status !== "ok") return replaced satisfies CompleteUploadResult;
          await addUsage(tx, upload.orgId, upload.size);
          await tx
            .update(storageUploads)
            .set({ nodeId: replaced.node.id })
            .where(eq(storageUploads.id, upload.id));
          return {
            status: "ok",
            node: replaced.node,
            r2Key: upload.r2Key,
            created: true,
          } satisfies CompleteUploadResult;
        }
        const at = await resolvePlace(
          tx,
          door,
          upload.parentId ? { parentId: upload.parentId } : { space: upload.space },
        );
        if (!at) return NOT_FOUND satisfies CompleteUploadResult;
        if (!at.writable) return FORBIDDEN satisfies CompleteUploadResult;
        const refusal = await full();
        if (refusal) return refusal satisfies CompleteUploadResult;
        const node = await insertNode(tx, {
          id: upload.id,
          drive: at.drive,
          parentId: at.parentId,
          kind: "file",
          name: upload.name,
          size: upload.size,
          mimeType: upload.mimeType,
          r2Key: upload.r2Key,
          contentSha256: upload.sha256,
          createdByMemberId: upload.memberId,
        });
        await addUsage(tx, upload.orgId, upload.size);
        await tx
          .update(storageUploads)
          .set({ nodeId: node.id })
          .where(eq(storageUploads.id, upload.id));
        return {
          status: "ok",
          node: toNode(node),
          r2Key: upload.r2Key,
          created: true,
        } satisfies CompleteUploadResult;
      });
    },

    async abortUpload(uploadId: string) {
      const upload = await mine(db, uploadId);
      if (!upload || upload.nodeId) return NOT_FOUND satisfies AbortUploadResult;
      const [row] = await db
        .delete(storageUploads)
        .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)))
        .returning({ r2Key: storageUploads.r2Key, r2UploadId: storageUploads.r2UploadId });
      return (row ? { status: "ok", ...row } : NOT_FOUND) satisfies AbortUploadResult;
    },
  };
}

/**
 * For the cron: forgets completed uploads past their time (the file stays) and returns those
 * nobody completed, oldest first. The caller aborts each in the bucket, then calls
 * `removeStorageUpload`.
 */
export async function expiredStorageUploads(db: Db, options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  await db
    .delete(storageUploads)
    .where(and(lt(storageUploads.expiresAt, now), isNotNull(storageUploads.nodeId)));
  return db
    .select({
      id: storageUploads.id,
      orgId: storageUploads.orgId,
      r2Key: storageUploads.r2Key,
      r2UploadId: storageUploads.r2UploadId,
    })
    .from(storageUploads)
    .where(and(lt(storageUploads.expiresAt, now), isNull(storageUploads.nodeId)))
    .orderBy(storageUploads.expiresAt)
    .limit(options.limit ?? 100);
}

/**
 * Deletes an upload nobody completed, and says whether it did. False when it is gone or was
 * completed after all: only a true answer means no file owns the object at its key.
 */
export async function removeStorageUpload(db: Db, uploadId: string) {
  const removed = await db
    .delete(storageUploads)
    .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)))
    .returning({ id: storageUploads.id });
  return removed.length > 0;
}
