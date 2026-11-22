import {
  storageCompleteUploadQuerySchema,
  STORAGE_MAX_PARTS,
  storageMoveUploadBodySchema,
  storageOpenUploadBodySchema,
  type StorageNodeResponse,
  type StorageUploadPartResponse,
  type StorageUploadResponse,
} from "@omni/contracts";
import type { StorageUpload, UploadCaps } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import type { Config } from "../env.ts";
import { apiError } from "../errors.ts";
import type { Logger } from "../log.ts";
import {
  abortMultipart,
  partCount,
  partLength,
  storageLimit,
  wireNode,
  wireUpload,
} from "./core.ts";
import { zValidator } from "../validator.ts";
import { announceDrives } from "./announce.ts";
import { journalSaved } from "./journal.ts";
import { placeOf, refused, staleSave, writeDoor } from "./http.ts";

const live = (upload: StorageUpload) => upload.expiresAt > new Date();
const answer = (upload: StorageUpload) =>
  ({ upload: wireUpload(upload) }) satisfies StorageUploadResponse;

/** The per-member ceilings on uploads in progress, from config. */
export const uploadCaps = (config: Config) =>
  ({
    maxOpenUploads: config.STORAGE_MAX_OPEN_UPLOADS,
    maxReservedBytes: config.STORAGE_MAX_RESERVED_BYTES,
  }) satisfies UploadCaps;

const isInvalidPart = (error: unknown) =>
  error instanceof Error && /InvalidPart|10025|parts could not be found/i.test(error.message);

async function finishObject(bucket: R2Bucket, upload: StorageUpload) {
  if (!upload.r2UploadId) {
    await bucket.put(upload.r2Key, new Uint8Array(0));
    return "ok" as const;
  }
  try {
    const parts = upload.parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
    await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).complete(parts);
    return "ok" as const;
  } catch (error) {
    const object = await bucket.head(upload.r2Key);
    if (object?.size === upload.size) return "ok" as const;
    if (isInvalidPart(error)) return "invalid_part" as const;
    throw error;
  }
}

async function objectSha256(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (!object) return null;
  const digest = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(digest);
  return [...new Uint8Array(await digest.digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function deleteObject(bucket: R2Bucket, key: string, log: Logger) {
  await bucket.delete(key).catch((error: unknown) => {
    log.error("storage.objects_left", { count: 1, error });
  });
}

async function findUpload(c: Context<AppEnv>, id: string) {
  const { files, orgId } = writeDoor(c);
  const upload = await files.upload(id);
  return upload?.orgId === orgId ? upload : null;
}

async function findUploadRow(c: Context<AppEnv>, id: string) {
  const { files, orgId } = writeDoor(c);
  const upload = await files.uploadRow(id);
  return upload?.orgId === orgId ? upload : null;
}

async function storePart(c: Context<AppEnv>, body: ReadableStream | null) {
  const n = Number(c.req.param("n"));
  const { files } = writeDoor(c);
  const upload = await findUploadRow(c, c.req.param("id") ?? "");
  if (!upload || (!upload.nodeId && !live(upload))) return refused(c, "not_found");
  if (upload.nodeId) return apiError(c, "upload_complete", "the upload is already a file");
  if (n < 1 || n > partCount(upload.size) || !upload.r2UploadId) {
    return apiError(c, "invalid_part", `the upload has ${partCount(upload.size)} parts`);
  }
  const expected = partLength(upload.size, n);
  if (!body || Number(c.req.header("content-length")) !== expected) {
    return apiError(c, "invalid_part", `part ${n} must be exactly ${expected} bytes`);
  }
  const multipart = c.env.STORAGE_BUCKET.resumeMultipartUpload(upload.r2Key, upload.r2UploadId);
  let etag: string;
  try {
    ({ etag } = await multipart.uploadPart(n, body));
  } catch (error) {
    const now = await files.uploadRow(upload.id);
    if (!now || now.nodeId) return refused(c, "not_found");
    throw error;
  }
  const recorded = await files.recordUploadPart(upload.id, {
    partNumber: n,
    etag,
    size: expected,
  });
  if (recorded.status !== "ok") return refused(c, recorded.status);
  return c.json({
    part: { partNumber: n, size: expected },
    expiresAt: recorded.expiresAt.toISOString(),
  } satisfies StorageUploadPartResponse);
}

async function prepareObject(c: Context<AppEnv>, upload: StorageUpload) {
  const { files } = writeDoor(c);
  const bucket = c.env.STORAGE_BUCKET;
  if (upload.parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
    return refused(c, "incomplete");
  }
  if ((await finishObject(bucket, upload)) === "invalid_part") {
    await files.clearUploadParts(upload.id);
    c.var.log.warn("storage.upload_parts_refused", { uploadId: upload.id });
    return apiError(c, "upload_incomplete", "the bucket refused the parts: send them all again");
  }
  const unchecked = upload.size > c.var.config.STORAGE_HASH_CHECK_MAX_BYTES;
  if (!upload.sha256 || upload.sha256CheckedAt || unchecked) return null;
  const started = Date.now();
  const actual = await objectSha256(bucket, upload.r2Key);
  c.var.log.info("storage.upload_hashed", { bytes: upload.size, ms: Date.now() - started });
  if (actual === upload.sha256) {
    await files.markUploadChecked(upload.id);
    return null;
  }
  const aborted = await files.abortUpload(upload.id);
  if (aborted.status === "ok") await deleteObject(bucket, aborted.r2Key, c.var.log);
  return apiError(c, "checksum_mismatch", "the bytes stored do not match the sha256 sent");
}

export const storageUploads = new Hono<AppEnv>()
  .post("/uploads", zValidator("json", storageOpenUploadBodySchema), async (c) => {
    const { name, size, mimeType, sha256, parentId, space, teamspaceId } = c.req.valid("json");
    const { db, config } = c.var;
    const { files, orgId } = writeDoor(c);
    if (size > config.STORAGE_MAX_FILE_BYTES || partCount(size) > STORAGE_MAX_PARTS) {
      return apiError(c, "file_too_large", "the file is larger than one file may be");
    }
    const { limitBytes } = await storageLimit(db, config, orgId);
    const opened = await files.openUpload(placeOf({ parentId, space, teamspaceId }), {
      name,
      size,
      mimeType,
      limitBytes,
      sha256,
      caps: uploadCaps(config),
    });
    if (opened.status !== "ok") return refused(c, opened.status);
    if (size === 0) return c.json(answer(opened.upload), 201);
    try {
      const multipart = await c.env.STORAGE_BUCKET.createMultipartUpload(opened.upload.r2Key);
      const started = await files.startUpload(opened.upload.id, multipart.uploadId);
      if (!started) throw new Error("storage: the upload was gone before it started");
      return c.json(answer(started), 201);
    } catch (error) {
      await files.abortUpload(opened.upload.id);
      throw error;
    }
  })

  .get("/uploads/:id", async (c) => {
    const upload = await findUpload(c, c.req.param("id"));
    if (!upload || (!upload.nodeId && !live(upload))) return refused(c, "not_found");
    return c.json(answer(upload));
  })

  .patch("/uploads/:id", zValidator("json", storageMoveUploadBodySchema), async (c) => {
    const { name, parentId, space, teamspaceId } = c.req.valid("json");
    const upload = await findUploadRow(c, c.req.param("id"));
    if (!upload) return refused(c, "not_found");
    const moved = await writeDoor(c).files.moveUpload(
      upload.id,
      placeOf({ parentId, space, teamspaceId }),
      name,
    );
    if (moved.status === "upload_complete") {
      return apiError(c, "upload_complete", "the upload is already a file");
    }
    if (moved.status !== "ok") return refused(c, moved.status);
    return c.json(answer(moved.upload));
  })

  .put("/uploads/:id/parts/:n{[0-9]+}", async (c) => {
    const body = c.req.raw.body;
    const stored = await storePart(c, body);
    if (body && !body.locked) await body.pipeTo(new WritableStream()).catch(() => {});
    return stored;
  })

  .post("/uploads/:id/complete", async (c) => {
    const guard = storageCompleteUploadQuerySchema.safeParse({
      ifContentVersion: c.req.query("ifContentVersion"),
    });
    if (!guard.success) {
      return apiError(c, "bad_request", "ifContentVersion must be a whole number");
    }
    const { ifContentVersion } = guard.data;
    const { db, config, log } = c.var;
    const { files } = writeDoor(c);
    const upload = await findUpload(c, c.req.param("id"));
    if (!upload) return refused(c, "not_found");
    if (!upload.nodeId) {
      if (!live(upload)) return refused(c, "not_found");
      const unready = await prepareObject(c, upload);
      if (unready) return unready;
    }
    const { limitBytes } = await storageLimit(db, config, upload.orgId);
    const done = await files.completeUpload(upload.id, { limitBytes, ifContentVersion });
    if (done.status === "ok") {
      announceDrives(c, [done.node]);
      journalSaved(c, done.node);
      return c.json({ node: wireNode(done.node) } satisfies StorageNodeResponse);
    }
    if (done.status === "not_found") {
      const aborted = await files.abortUpload(upload.id);
      if (aborted.status === "ok") await deleteObject(c.env.STORAGE_BUCKET, aborted.r2Key, log);
    }
    if (done.status === "version_conflict") return staleSave(c, done.contentVersion);
    return refused(c, done.status);
  })

  .delete("/uploads/:id", async (c) => {
    const aborted = await writeDoor(c).files.abortUpload(c.req.param("id"));
    if (aborted.status !== "ok") return refused(c, aborted.status);
    await abortMultipart(c.env.STORAGE_BUCKET, aborted.r2Key, aborted.r2UploadId);
    await deleteObject(c.env.STORAGE_BUCKET, aborted.r2Key, c.var.log);
    return c.body(null, 204);
  });
