// Uploads in progress (ADR 0034 decision 5). The quota is checked here against the number the
// caller passes: this package reads no configuration. An upload's id becomes its file's id.
import { and, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { storageUploads, type StorageUploadPart } from "../schema/storage.ts";
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
  type NotFound,
  type StoragePlace,
} from "./tree.ts";

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

export type RecordPartResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  /** With this part the upload would hold more bytes than it declared. */
  | { status: "too_large" };

export type CompleteUploadResult =
  /** `created` is false when the upload had already completed: the same file comes back. */
  | { status: "ok"; node: StorageNode; r2Key: string; created: boolean }
  | NotFound
  | Forbidden
  /** The parts do not add up to the declared size. */
  | { status: "incomplete" }
  | StorageFull;

export type AbortUploadResult =
  /** The row is gone; the caller aborts the multipart upload in the bucket, if it was opened. */
  { status: "ok"; r2Key: string; r2UploadId: string | null } | NotFound;

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

/** Still in progress: not completed, not past its time. */
const live = (upload: StorageUpload) => !upload.nodeId && upload.expiresAt > new Date();

export function uploadOperations(db: Db, door: Door) {
  /** The holder's own upload, locked when `lock` is set. */
  async function mine(ex: Db, uploadId: string, lock = false) {
    const query = ex.select().from(storageUploads).where(eq(storageUploads.id, uploadId));
    const [upload] = await (lock ? query.for("update") : query);
    if (!upload || !(await door.ownsUpload(ex, upload.memberId))) return null;
    return upload;
  }

  return {
    /**
     * Opens an upload of `size` bytes into a place the holder may write. `limitBytes` is the
     * workspace's allowance, null for none. The workspace's usage row is locked while the bytes
     * stored, the uploads in progress and this one are added up, so two opens cannot both take
     * the last of the room.
     */
    async openUpload(
      place: StoragePlace,
      file: { name: string; size: number; mimeType?: string | null; limitBytes: number | null },
    ): Promise<OpenUploadResult> {
      const name = cleanName(file.name);
      if (!name) return { status: "invalid_name" };
      return db.transaction(async (tx): Promise<OpenUploadResult> => {
        const at = await resolvePlace(tx, door, place);
        if (!at) return NOT_FOUND;
        if (!at.writable) return FORBIDDEN;
        const { orgId } = at.drive;
        const actor = await door.actor(tx, orgId);
        if (!actor) return FORBIDDEN;
        const usedBytes = await lockUsage(tx, orgId);
        const reserved = await reservedBytes(tx, orgId);
        if (file.limitBytes !== null && usedBytes + reserved + file.size > file.limitBytes) {
          return {
            status: "full",
            usedBytes,
            reservedBytes: reserved,
            limitBytes: file.limitBytes,
          };
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
            r2Key: storageObjectKey(orgId, id),
            expiresAt: new Date(Date.now() + STORAGE_UPLOAD_TTL_MS),
          })
          .returning();
        return { status: "ok", upload: upload! };
      });
    },

    /** The holder's upload, with the parts it already lists (what a resume needs). */
    async upload(uploadId: string): Promise<StorageUpload | null> {
      return mine(db, uploadId);
    },

    /** Records the bucket's multipart upload id, once the bucket has opened it. */
    async startUpload(uploadId: string, r2UploadId: string): Promise<StorageUpload | null> {
      const upload = await mine(db, uploadId);
      if (!upload || !live(upload)) return null;
      const [row] = await db
        .update(storageUploads)
        .set({ r2UploadId })
        .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.r2UploadId)))
        .returning();
      return row ?? (upload.r2UploadId === r2UploadId ? upload : null);
    },

    /**
     * Records a part the bucket acknowledged. Sending a part again replaces it, and parts sent
     * in parallel queue on the upload's row, so none is lost.
     */
    recordUploadPart(uploadId: string, part: StorageUploadPart): Promise<RecordPartResult> {
      return db.transaction(async (tx): Promise<RecordPartResult> => {
        const upload = await mine(tx, uploadId, true);
        if (!upload || !live(upload)) return NOT_FOUND;
        const parts = [
          ...upload.parts.filter((other) => other.partNumber !== part.partNumber),
          part,
        ].toSorted((a, b) => a.partNumber - b.partNumber);
        if (parts.reduce((sum, each) => sum + each.size, 0) > upload.size) {
          return { status: "too_large" };
        }
        const [row] = await tx
          .update(storageUploads)
          .set({ parts })
          .where(eq(storageUploads.id, uploadId))
          .returning();
        return { status: "ok", upload: row! };
      });
    },

    /**
     * Turns the upload into a file: inserts the node, adds its size to the workspace's usage and
     * marks the upload, in one transaction. Completing again returns the same file and counts
     * nothing, while the holder still reaches it. Access to the folder and the allowance are
     * checked again, as they may have changed since the upload opened.
     */
    async completeUpload(
      uploadId: string,
      options: { limitBytes: number | null },
    ): Promise<CompleteUploadResult> {
      const seen = await mine(db, uploadId);
      if (!seen) return NOT_FOUND;
      return db.transaction(async (tx): Promise<CompleteUploadResult> => {
        // The tree first, so the folder cannot change drive between the lookup below and the
        // insert. Then the usage row, then the upload row: the order a delete takes them in.
        await lockTree(tx, seen.orgId);
        const usedBytes = await lockUsage(tx, seen.orgId);
        const upload = await mine(tx, uploadId, true);
        if (!upload) return NOT_FOUND;
        if (upload.nodeId) {
          // Through the door as it stands now: the file may have left what the holder reaches.
          const found = await reach(tx, door, upload.nodeId);
          return found
            ? { status: "ok", node: toNode(found.node), r2Key: upload.r2Key, created: false }
            : NOT_FOUND;
        }
        if (!live(upload)) return NOT_FOUND;
        if (upload.parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
          return { status: "incomplete" };
        }
        const at = await resolvePlace(
          tx,
          door,
          upload.parentId ? { parentId: upload.parentId } : { space: upload.space },
        );
        if (!at) return NOT_FOUND;
        if (!at.writable) return FORBIDDEN;
        const { limitBytes } = options;
        if (limitBytes !== null && usedBytes + upload.size > limitBytes) {
          const reserved = await reservedBytes(tx, upload.orgId, upload.id);
          return { status: "full", usedBytes, reservedBytes: reserved, limitBytes };
        }
        const node = await insertNode(tx, {
          id: upload.id,
          drive: at.drive,
          parentId: at.parentId,
          kind: "file",
          name: upload.name,
          size: upload.size,
          mimeType: upload.mimeType,
          r2Key: upload.r2Key,
          createdByMemberId: upload.memberId,
        });
        await addUsage(tx, upload.orgId, upload.size);
        await tx
          .update(storageUploads)
          .set({ nodeId: node.id })
          .where(eq(storageUploads.id, upload.id));
        return { status: "ok", node: toNode(node), r2Key: upload.r2Key, created: true };
      });
    },

    /** Drops an upload in progress. A completed one is a file: trash that instead. */
    async abortUpload(uploadId: string): Promise<AbortUploadResult> {
      const upload = await mine(db, uploadId);
      if (!upload || upload.nodeId) return NOT_FOUND;
      const [row] = await db
        .delete(storageUploads)
        .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)))
        .returning({ r2Key: storageUploads.r2Key, r2UploadId: storageUploads.r2UploadId });
      return row ? { status: "ok", ...row } : NOT_FOUND;
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

/** Deletes an upload nobody completed. A no-op when it is gone, or completed after all. */
export async function removeStorageUpload(db: Db, uploadId: string) {
  await db
    .delete(storageUploads)
    .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)));
}
