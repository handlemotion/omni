import { and, eq, gt, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import {
  storageUploadParts,
  storageUploads,
  storageUploadTargets,
  type StorageUploadPart,
} from "../schema/storage.ts";
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
  resolveUploadPlace,
  type Forbidden,
  type InvalidName,
  type Locked,
  type NotFound,
  type StoragePlace,
} from "./tree.ts";
import {
  capped,
  otherPartBytes,
  partsOf,
  withParts,
  reservedBytes,
  type StorageFull,
  type TooManyUploads,
  type UploadCaps,
} from "./upload-rows.ts";
import { moveUploadLink } from "./upload-links.ts";
import { mayReplace, replaceContent, staleFor, type StaleContent } from "./versions.ts";

export {
  expiredStorageUploads,
  removeStorageUpload,
  reservedBytes,
  type StorageFull,
  type TooManyUploads,
  type UploadCaps,
} from "./upload-rows.ts";

/** An upload that receives no part for this long is aborted. Each part recorded restarts it. */
export const STORAGE_UPLOAD_TTL_MS = 24 * 60 * 60_000;
/**
 * However many parts keep arriving, an upload closes this long after it opened: R2 aborts a
 * multipart upload nobody completed after 7 days, and the parts would be gone before the row.
 */
export const STORAGE_UPLOAD_MAX_AGE_MS = 6 * 24 * 60 * 60_000;

/** An upload with every part recorded so far, in part order. */
export type StorageUpload = typeof storageUploads.$inferSelect;

export type OpenUploadResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | Forbidden
  | InvalidName
  | StorageFull
  | TooManyUploads;

export type OpenVersionUploadResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | Forbidden
  | Locked
  | StaleContent
  | StorageFull
  | TooManyUploads;

export type RecordPartResult =
  | { status: "ok"; part: StorageUploadPart; expiresAt: Date }
  | NotFound
  | { status: "too_large" };

export type MoveUploadResult =
  | { status: "ok"; upload: StorageUpload }
  | NotFound
  | Forbidden
  | InvalidName
  | { status: "upload_complete" };

export type CompleteUploadResult =
  | { status: "ok"; node: StorageNode; r2Key: string; created: boolean }
  | NotFound
  | Forbidden
  | { status: "incomplete" }
  | { status: "parent_trashed" }
  | Locked
  | StaleContent
  | StorageFull;

export type AbortUploadResult =
  | { status: "ok"; r2Key: string; r2UploadId: string | null }
  | NotFound;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

async function targetOf(ex: Db, uploadId: string) {
  const [row] = await ex
    .select({
      nodeId: storageUploadTargets.nodeId,
    })
    .from(storageUploadTargets)
    .where(eq(storageUploadTargets.uploadId, uploadId));
  return row ?? null;
}

const slidExpiry = (createdAt: Date) =>
  new Date(
    Math.min(Date.now() + STORAGE_UPLOAD_TTL_MS, createdAt.getTime() + STORAGE_UPLOAD_MAX_AGE_MS),
  );

const isRollback = (error: unknown) => error instanceof TransactionRollbackError;

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
    const at = await resolveUploadPlace(
      ex,
      door,
      upload.parentId ? { parentId: upload.parentId } : { space: upload.space },
      upload.name,
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
        caps?: UploadCaps;
      },
    ) {
      const name = cleanName(file.name);
      if (!name) return { status: "invalid_name" } satisfies OpenUploadResult;
      return db.transaction<OpenUploadResult>(async (tx) => {
        const at = await resolveUploadPlace(tx, door, place, name);
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
        const tooMany = await capped(tx, orgId, actor, file.size, file.caps ?? {});
        if (tooMany) {
          const result: OpenUploadResult = tooMany;
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
        caps?: UploadCaps;
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
        const tooMany = await capped(tx, node.orgId, actor, file.size, file.caps ?? {});
        if (tooMany) return tooMany satisfies OpenVersionUploadResult;
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

    async uploadRow(uploadId: string) {
      return mine(db, uploadId) satisfies Promise<StorageUpload | null>;
    },

    async upload(uploadId: string) {
      const upload = await mine(db, uploadId);
      return (upload ? await withParts(db, upload) : null) satisfies StorageUpload | null;
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

    async recordUploadPart(uploadId: string, part: StorageUploadPart) {
      const seen = await mine(db, uploadId);
      if (!seen) return NOT_FOUND satisfies RecordPartResult;
      return db
        .transaction<RecordPartResult>(async (tx) => {
          const [upload] = await tx
            .update(storageUploads)
            .set({ expiresAt: slidExpiry(seen.createdAt) })
            .where(
              and(
                eq(storageUploads.id, uploadId),
                isNull(storageUploads.nodeId),
                gt(storageUploads.expiresAt, new Date()),
              ),
            )
            .returning();
          if (!upload) return NOT_FOUND satisfies RecordPartResult;
          if ((await otherPartBytes(tx, upload, part.partNumber)) + part.size > upload.size) {
            tx.rollback();
          }
          await tx
            .insert(storageUploadParts)
            .values({ uploadId, orgId: upload.orgId, ...part })
            .onConflictDoUpdate({
              target: [storageUploadParts.uploadId, storageUploadParts.partNumber],
              set: { etag: part.etag, size: part.size, createdAt: sql`now()` },
            });
          return { status: "ok", part, expiresAt: upload.expiresAt } satisfies RecordPartResult;
        })
        .catch((error: unknown) => {
          if (isRollback(error)) return { status: "too_large" } satisfies RecordPartResult;
          throw error;
        });
    },

    async clearUploadParts(uploadId: string) {
      const upload = await mine(db, uploadId);
      if (!upload || upload.nodeId) return false;
      await db.transaction(async (tx) => {
        await tx.delete(storageUploadParts).where(eq(storageUploadParts.uploadId, uploadId));
        await tx
          .update(storageUploads)
          .set({ parts: [], sha256CheckedAt: null })
          .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)));
      });
      return true;
    },

    async markUploadChecked(uploadId: string) {
      await db
        .update(storageUploads)
        .set({ sha256CheckedAt: new Date() })
        .where(and(eq(storageUploads.id, uploadId), isNull(storageUploads.nodeId)));
    },

    async moveUpload(uploadId: string, place: StoragePlace, rename?: string) {
      const name = rename === undefined ? undefined : cleanName(rename);
      if (name === null) return { status: "invalid_name" } satisfies MoveUploadResult;
      return db.transaction<MoveUploadResult>(async (tx) => {
        const upload = await mine(tx, uploadId, true);
        if (!upload) return NOT_FOUND satisfies MoveUploadResult;
        if (upload.nodeId) return { status: "upload_complete" } satisfies MoveUploadResult;
        if (!live(upload) || (await targetOf(tx, upload.id))) {
          return NOT_FOUND satisfies MoveUploadResult;
        }
        const at = await resolvePlace(tx, door, place);
        if (!at || at.drive.orgId !== upload.orgId) return NOT_FOUND satisfies MoveUploadResult;
        if (!at.writable) return FORBIDDEN satisfies MoveUploadResult;
        const [row] = await tx
          .update(storageUploads)
          .set({ space: at.drive.space, parentId: at.parentId, ...(name ? { name } : {}) })
          .where(eq(storageUploads.id, uploadId))
          .returning();
        return { status: "ok", upload: await withParts(tx, row!) } satisfies MoveUploadResult;
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
        const parts = await partsOf(tx, upload);
        if (parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
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
        const at = await resolveUploadPlace(
          tx,
          door,
          upload.parentId ? { parentId: upload.parentId } : { space: upload.space },
          upload.name,
        );
        if (!at) {
          return (
            upload.parentId ? { status: "parent_trashed" } : NOT_FOUND
          ) satisfies CompleteUploadResult;
        }
        if (!at.writable) return FORBIDDEN satisfies CompleteUploadResult;
        const refusal = await full();
        if (refusal) return refusal satisfies CompleteUploadResult;
        const inserted = await insertNode(tx, {
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
          attached: at.attached,
        });
        const node = await moveUploadLink(tx, upload.id, inserted);
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
