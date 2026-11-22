import {
  STORAGE_PART_BYTES,
  STORAGE_THUMBNAIL_SIZES,
  type StorageNode,
  type StorageUpload,
} from "@omni/contracts";
import {
  storageOverageOf,
  workspaceKind,
  workspaceSubscription,
  type Db,
  type StorageNode as NodeRow,
  type StorageUpload as UploadRow,
  type WorkspaceSubscription,
} from "@omni/db";
import { period } from "../billing.ts";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";

const GB = 1024 ** 3;

export interface StorageLimit {
  /** Bytes nothing passes: a full workspace answers `402 storage_full`. Null: no cap. */
  limitBytes: number | null;
  /** Bytes the plan includes before extra storage is billed. Null: no plan. */
  allowanceBytes: number | null;
  /**
   * Set when storage past the allowance is billed instead of refused: the start of the usage
   * month whose peak is billed.
   */
  overagePeriodStart: Date | null;
}

/**
 * Whether a subscription row is one whose extra storage can be billed: paying (a trial is not),
 * monthly (a yearly plan cannot carry the monthly metered price), and with
 * no scheduled change that would rewrite its items.
 */
export function billsOverage(
  subscription: Pick<
    NonNullable<WorkspaceSubscription>,
    "status" | "billingInterval" | "stripeSubscriptionId" | "stripeScheduleId"
  > | null,
): subscription is NonNullable<typeof subscription> & { stripeSubscriptionId: string } {
  return (
    subscription !== null &&
    (subscription.status === "active" || subscription.status === "past_due") &&
    subscription.billingInterval === "month" &&
    subscription.stripeSubscriptionId !== null &&
    !subscription.stripeScheduleId
  );
}

/**
 * Whole GB of `peakBytes` above the allowance: what the meter is told. Rounded down, so a
 * customer pays for each extra GB only once it is full.
 */
export function extraGb(peakBytes: number, allowanceBytes: number) {
  return Math.max(0, Math.floor((peakBytes - allowanceBytes) / GB));
}

/**
 * How much `orgId` may store: the one place the quota is decided.
 *
 * - `STORAGE_MAX_GB` caps every workspace, and `STORAGE_PERSONAL_GB` a Personal space, which
 *   never has a plan. Without billing these are the only limits.
 * - With billing on and storage on the plan, a company has the plan's allowance. It is also its
 *   cap unless extra storage can be billed: a paying monthly subscription that Stripe showed
 *   with a payment method. A trial, a yearly plan, no card and no plan are all capped.
 */
export async function storageLimit(db: Db, config: Config, orgId: string, now = new Date()) {
  const caps: number[] = [];
  if (config.STORAGE_MAX_GB !== undefined) caps.push(config.STORAGE_MAX_GB);
  const personal = (await workspaceKind(db, orgId)) === "personal";
  if (personal && config.STORAGE_PERSONAL_GB !== undefined) caps.push(config.STORAGE_PERSONAL_GB);
  const plan = personal ? undefined : config.auth.billing?.storage;
  let overagePeriodStart: Date | null = null;
  if (plan) {
    const subscription = await workspaceSubscription(db, orgId);
    if (
      billsOverage(subscription) &&
      (await storageOverageOf(db, orgId)) === subscription.stripeSubscriptionId
    ) {
      overagePeriodStart = period(subscription, now)?.start ?? null;
    }
    if (!overagePeriodStart) caps.push(plan.includedGb);
  }
  return {
    limitBytes: caps.length ? Math.floor(Math.min(...caps) * GB) : null,
    allowanceBytes: plan ? Math.floor(plan.includedGb * GB) : null,
    overagePeriodStart,
  } satisfies StorageLimit;
}

export const wireNode: (node: NodeRow) => StorageNode = (node) => {
  return {
    ...node,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
    trashedAt: node.trashedAt?.toISOString() ?? null,
    lockedAt: node.lockedAt?.toISOString() ?? null,
  };
};

/** How many parts a file of `size` bytes goes up in. An empty file has none. */
export const partCount = (size: number) => Math.ceil(size / STORAGE_PART_BYTES);

/** The exact length part `n` must have: every part is full but the last. */
export function partLength(size: number, n: number) {
  return n < partCount(size) ? STORAGE_PART_BYTES : size - STORAGE_PART_BYTES * (n - 1);
}

/** An upload as its client sees it: no object key, no bucket ids. */
export function wireUpload(upload: UploadRow) {
  return {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    mimeType: upload.mimeType,
    space: upload.space,
    teamspaceId: upload.teamspaceId,
    parentId: upload.parentId,
    partSize: STORAGE_PART_BYTES,
    partCount: partCount(upload.size),
    parts: upload.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    expiresAt: upload.expiresAt.toISOString(),
    nodeId: upload.nodeId,
  } satisfies StorageUpload;
}

/**
 * Where a file's thumbnail of `size` is kept (`thumbnails.ts`): beside its object, under the
 * workspace's prefix, so a new version (a new object) gets new thumbnails and the workspace sweep
 * takes them with it.
 */
export const thumbnailKey = (r2Key: string, size: number) => `${r2Key}.thumbnail-${size}.webp`;

/**
 * Deletes objects whose rows are already gone, with any thumbnails drawn from them, 1000 keys a
 * call. A failure is logged with the
 * count and not thrown: the rows are the truth, and the caller's work is done either way.
 */
export async function deleteStorageObjects(bucket: R2Bucket, objects: string[], log: Logger) {
  const keys = objects.flatMap((key) => [
    key,
    ...STORAGE_THUMBNAIL_SIZES.map((size) => thumbnailKey(key, size)),
  ]);
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
export const parseRange: (
  header: string | undefined,
  size: number,
) => ByteRange | "unsatisfiable" | null = (header, size) => {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { offset: size - length, length } : "unsatisfiable";
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
};

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

const PLAYABLE_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "video/mp4",
  "video/ogg",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);

/** The type a file leaves with: its own for playable media, `application/octet-stream` else. */
export function servedType(mimeType: string | null) {
  const type = mimeType?.split(";")[0]!.trim().toLowerCase();
  return type && PLAYABLE_TYPES.has(type) ? type : "application/octet-stream";
}

const CONDITIONS = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since"];

/** The request's preconditions, for `R2Bucket.get`'s `onlyIf`. */
export function conditionsOf(request: Headers) {
  const conditions = new Headers();
  for (const name of CONDITIONS) {
    const value = request.get(name);
    if (value !== null) conditions.set(name, value);
  }
  return conditions;
}

/**
 * What an object R2 held back answers: a failed `If-Match` or `If-Unmodified-Since` is `412`,
 * a met `If-None-Match` or `If-Modified-Since` (nothing changed) is `304`.
 */
export const unchangedStatus = (conditions: Headers) =>
  conditions.has("if-none-match") || conditions.has("if-modified-since") ? 304 : 412;

/**
 * Streams a file out of the bucket, honouring one `Range`, `If-Range` and the conditional
 * headers (`304` when the client's copy is current). It leaves as an attachment with `nosniff`,
 * as `application/octet-stream` unless it is playable audio or video (`servedType`): nothing a
 * person uploaded ever renders on our origin. The browser may keep it, but revalidates before
 * each use (`no-cache`). Null when the object is not in the bucket.
 */
export const fileResponse: (
  bucket: R2Bucket,
  file: { name: string; size: number; r2Key: string; mimeType: string | null },
  request: Headers,
) => Promise<Response | null> = async (bucket, file, request) => {
  const headers = new Headers({
    "content-type": servedType(file.mimeType),
    "content-disposition": attachmentDisposition(file.name),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
  });
  let range = parseRange(request.get("range") ?? undefined, file.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const conditions = conditionsOf(request);
  const onlyIf = new Headers(conditions);
  const ifRange = request.get("if-range");
  if (range && ifRange !== null && !/^(W\/)?"/.test(ifRange)) range = null;
  const guarded = range !== null && ifRange !== null && !onlyIf.has("if-match");
  if (guarded) onlyIf.set("if-match", ifRange);
  let object = await bucket.get(file.r2Key, { onlyIf, ...(range ? { range } : {}) });
  if (guarded && object && !("body" in object)) {
    onlyIf.delete("if-match");
    range = null;
    object = await bucket.get(file.r2Key, { onlyIf });
  }
  if (!object) return null;
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  if (!("body" in object)) {
    return new Response(null, { status: unchangedStatus(conditions), headers });
  }
  headers.set("content-length", String(range ? range.length : object.size));
  if (!range) return new Response(object.body, { headers });
  const last = range.offset + range.length - 1;
  headers.set("content-range", `bytes ${range.offset}-${last}/${object.size}`);
  return new Response(object.body, { status: 206, headers });
};
