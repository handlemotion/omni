import { STORAGE_PART_BYTES, type StorageNode, type StorageUpload } from "@omni/contracts";
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
 * monthly (a yearly plan cannot carry the monthly metered price, ADR 0034 amendment), and with
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
 * How much `orgId` may store: the one place the quota is decided (ADR 0034 decision 7).
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
    parentId: upload.parentId,
    partSize: STORAGE_PART_BYTES,
    partCount: partCount(upload.size),
    parts: upload.parts.map(({ partNumber, size }) => ({ partNumber, size })),
    expiresAt: upload.expiresAt.toISOString(),
    nodeId: upload.nodeId,
  } satisfies StorageUpload;
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

/**
 * Streams a file out of the bucket, honouring one `Range`. Whatever was uploaded, it leaves as
 * `application/octet-stream`, as an attachment, with `nosniff`: nothing a person uploaded ever
 * renders on our origin. Null when the object is not in the bucket.
 */
export const fileResponse: (
  bucket: R2Bucket,
  file: { name: string; size: number; r2Key: string },
  request: { range?: string; ifRange?: string },
) => Promise<Response | null> = async (bucket, file, request) => {
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": attachmentDisposition(file.name),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  });
  let range = parseRange(request.range, file.size);
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
};
