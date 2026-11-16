// Storage (ADR 0034) as the Worker's routes and crons share it: how much a workspace may store,
// how a file is served, and how objects leave the bucket. Access is decided in `@omni/db`.
import { STORAGE_PART_BYTES, type StorageNode, type StorageUpload } from "@omni/contracts";
import {
  workspaceKind,
  type Db,
  type StorageNode as NodeRow,
  type StorageUpload as UploadRow,
} from "@omni/db";
import type { Config } from "./env.ts";
import type { Logger } from "./log.ts";

const GB = 1024 ** 3;

export interface StorageLimit {
  /** Bytes nothing passes: a full workspace answers `402 STORAGE_FULL`. Null: no cap. */
  limitBytes: number | null;
  /** Bytes the plan includes before extra storage is billed. Null: no plan. */
  allowanceBytes: number | null;
}

/**
 * How much `orgId` may store: the one place the quota is decided. Without billing only the two
 * optional caps exist, `STORAGE_PERSONAL_GB` for a Personal space and `STORAGE_MAX_GB` for any
 * workspace. The plan's allowance and its cap without a card (ADR 0034 decision 7) are added here.
 */
export async function storageLimit(db: Db, config: Config, orgId: string): Promise<StorageLimit> {
  const caps: number[] = [];
  if (config.STORAGE_MAX_GB !== undefined) caps.push(config.STORAGE_MAX_GB);
  if (config.STORAGE_PERSONAL_GB !== undefined && (await workspaceKind(db, orgId)) === "personal") {
    caps.push(config.STORAGE_PERSONAL_GB);
  }
  return {
    limitBytes: caps.length ? Math.floor(Math.min(...caps) * GB) : null,
    allowanceBytes: null,
  };
}

export function wireNode(node: NodeRow): StorageNode {
  return {
    ...node,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    trashedAt: node.trashedAt?.toISOString() ?? null,
  };
}

/** How many parts a file of `size` bytes goes up in. An empty file has none. */
export const partCount = (size: number) => Math.ceil(size / STORAGE_PART_BYTES);

/** The exact length part `n` must have: every part is full but the last. */
export function partLength(size: number, n: number) {
  return n < partCount(size) ? STORAGE_PART_BYTES : size - STORAGE_PART_BYTES * (n - 1);
}

/** An upload as its client sees it: no object key, no bucket ids. */
export function wireUpload(upload: UploadRow): StorageUpload {
  return {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    mimeType: upload.mimeType,
    space: upload.space,
    parentId: upload.parentId,
    partSize: STORAGE_PART_BYTES,
    partCount: partCount(upload.size),
    parts: upload.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    expiresAt: upload.expiresAt.toISOString(),
    nodeId: upload.nodeId,
  };
}

/**
 * Deletes objects whose rows are already gone, 1000 keys a call. A failure is logged with the
 * count and not thrown: the rows are the truth, and the caller's work is done either way.
 */
export async function deleteStorageObjects(bucket: R2Bucket, keys: string[], log: Logger) {
  for (let at = 0; at < keys.length; at += 1000) {
    const batch = keys.slice(at, at + 1000);
    await bucket.delete(batch).catch((error: unknown) => {
      log.error("storage.objects_left", { count: batch.length, error });
    });
  }
}

/**
 * Aborts a multipart upload in the bucket. One already gone (completed, aborted) is fine, and
 * one that could not be aborted now is aborted by R2 itself after 7 days.
 */
export async function abortMultipart(bucket: R2Bucket, key: string, uploadId: string | null) {
  if (!uploadId) return;
  await bucket
    .resumeMultipartUpload(key, uploadId)
    .abort()
    .catch(() => {});
}

type ByteRange = { offset: number; length: number };

/**
 * One `Range` header against a file of `size` bytes: the slice to serve, `"unsatisfiable"`
 * (416), or null to serve the whole file. Anything but a single byte range is ignored, as
 * RFC 9110 allows.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // The last N bytes.
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { offset: size - length, length } : "unsatisfiable";
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/**
 * `attachment` with the file's name: a plain fallback for old clients, and the real name in
 * RFC 5987 form. `encodeURIComponent` leaves `'()*` bare, which that form does not allow.
 */
export function attachmentDisposition(name: string) {
  const fallback = name.replaceAll(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a file out of the bucket, honouring one `Range`. Whatever was uploaded, it leaves as
 * `application/octet-stream`, as an attachment, with `nosniff`: nothing a person uploaded ever
 * renders on our origin. Null when the object is not in the bucket.
 */
export async function fileResponse(
  bucket: R2Bucket,
  file: { name: string; size: number; r2Key: string },
  request: { range?: string; ifRange?: string },
): Promise<Response | null> {
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": attachmentDisposition(file.name),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  });
  let range = parseRange(request.range, file.size);
  // A resumed download names the version it has; when the file is another, it starts over.
  if (range && request.ifRange !== undefined) {
    const head = await bucket.head(file.r2Key);
    if (head?.httpEtag !== request.ifRange) range = null;
  }
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await bucket.get(file.r2Key, range ? { range } : undefined);
  if (!object) return null;
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(range ? range.length : object.size));
  if (!range) return new Response(object.body, { headers });
  const last = range.offset + range.length - 1;
  headers.set("content-range", `bytes ${range.offset}-${last}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
}
