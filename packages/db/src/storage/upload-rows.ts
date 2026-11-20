import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageUploadParts, storageUploads } from "../schema/storage.ts";

type UploadRow = typeof storageUploads.$inferSelect;

/**
 * Per-member ceilings on uploads in progress, so one client cannot hold a workspace's room or
 * fill the table with uploads it never sends. Undefined: no ceiling.
 */
export interface UploadCaps {
  maxOpenUploads?: number;
  maxReservedBytes?: number;
}

/** The member already has as many uploads in progress, or as many bytes, as they may. */
export interface TooManyUploads {
  status: "too_many_uploads";
  openUploads: number;
  reservedBytes: number;
}

/** The workspace has no room for the file. Trashed files and uploads in progress count. */
export interface StorageFull {
  status: "full";
  usedBytes: number;
  /** Declared sizes of the other uploads in progress. */
  reservedBytes: number;
  limitBytes: number;
}

/**
 * The parts recorded for `upload`, in order: its rows, and any an older Worker kept in the
 * legacy `parts` column (a row wins for the same number).
 */
export async function partsOf(ex: Db, upload: UploadRow) {
  const rows = await ex
    .select({
      partNumber: storageUploadParts.partNumber,
      etag: storageUploadParts.etag,
      size: storageUploadParts.size,
    })
    .from(storageUploadParts)
    .where(eq(storageUploadParts.uploadId, upload.id))
    .orderBy(asc(storageUploadParts.partNumber));
  if (!upload.parts.length) return rows;
  const numbers = new Set(rows.map((row) => row.partNumber));
  return [...rows, ...upload.parts.filter((part) => !numbers.has(part.partNumber))].toSorted(
    (a, b) => a.partNumber - b.partNumber,
  );
}

/** `upload` with every part recorded so far. */
export const withParts = async (ex: Db, upload: UploadRow) => ({
  ...upload,
  parts: await partsOf(ex, upload),
});

/** Bytes of `upload`'s parts other than `partNumber`. */
export async function otherPartBytes(ex: Db, upload: UploadRow, partNumber: number) {
  const [row] = await ex
    .select({ bytes: sql<string>`coalesce(sum(${storageUploadParts.size}), 0)` })
    .from(storageUploadParts)
    .where(
      and(
        eq(storageUploadParts.uploadId, upload.id),
        sql`${storageUploadParts.partNumber} <> ${partNumber}`,
      ),
    );
  const legacy = upload.parts.filter((part) => part.partNumber !== partNumber);
  return Number(row?.bytes ?? 0) + legacy.reduce((sum, part) => sum + part.size, 0);
}

/** A member's uploads in progress in `orgId`: how many, and their declared bytes. */
export async function openUploadsOf(ex: Db, orgId: string, memberId: string) {
  const [row] = await ex
    .select({
      count: sql<string>`count(*)`,
      bytes: sql<string>`coalesce(sum(${storageUploads.size}), 0)`,
    })
    .from(storageUploads)
    .where(
      and(
        eq(storageUploads.orgId, orgId),
        eq(storageUploads.memberId, memberId),
        isNull(storageUploads.nodeId),
        gt(storageUploads.expiresAt, new Date()),
      ),
    );
  return { openUploads: Number(row?.count ?? 0), reservedBytes: Number(row?.bytes ?? 0) };
}

/** The refusal when one more upload of `size` bytes would pass the member's caps, else null. */
export async function capped(
  ex: Db,
  orgId: string,
  memberId: string,
  size: number,
  caps: UploadCaps,
) {
  if (caps.maxOpenUploads === undefined && caps.maxReservedBytes === undefined) return null;
  const open = await openUploadsOf(ex, orgId, memberId);
  const overCount = caps.maxOpenUploads !== undefined && open.openUploads >= caps.maxOpenUploads;
  const overBytes =
    caps.maxReservedBytes !== undefined && open.reservedBytes + size > caps.maxReservedBytes;
  return overCount || overBytes ? ({ status: "too_many_uploads", ...open } as const) : null;
}

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
