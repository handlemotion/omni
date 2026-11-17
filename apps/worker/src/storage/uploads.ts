import {
  storageCompleteUploadQuerySchema,
  STORAGE_MAX_PARTS,
  storageOpenUploadBodySchema,
  type StorageNodeResponse,
  type StorageUploadResponse,
} from "@omni/contracts";
import type { StorageUpload } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
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
import { placeOf, refused, staleSave, writeDoor } from "./http.ts";

const live = (upload: StorageUpload) => upload.expiresAt > new Date();
const answer = (upload: StorageUpload) =>
  ({ upload: wireUpload(upload) }) satisfies StorageUploadResponse;

async function finishObject(bucket: R2Bucket, upload: StorageUpload) {
  if (!upload.r2UploadId) return bucket.put(upload.r2Key, new Uint8Array(0));
  try {
    const parts = upload.parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
    await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).complete(parts);
  } catch (error) {
    const object = await bucket.head(upload.r2Key);
    if (object?.size !== upload.size) throw error;
  }
}

async function findUpload(c: Context<AppEnv>, id: string) {
  const { files, orgId } = writeDoor(c);
  const upload = await files.upload(id);
  return upload?.orgId === orgId ? upload : null;
}

async function storePart(c: Context<AppEnv>, body: ReadableStream | null) {
  const n = Number(c.req.param("n"));
  const { files } = writeDoor(c);
  const upload = await findUpload(c, c.req.param("id") ?? "");
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
    const now = await files.upload(upload.id);
    if (!now || now.nodeId) return refused(c, "not_found");
    throw error;
  }
  const recorded = await files.recordUploadPart(upload.id, {
    partNumber: n,
    etag,
    size: expected,
  });
  if (recorded.status !== "ok") return refused(c, recorded.status);
  return c.json(answer(recorded.upload));
}

export const storageUploads = new Hono<AppEnv>()
  .post("/uploads", zValidator("json", storageOpenUploadBodySchema), async (c) => {
    const { name, size, mimeType, sha256, parentId, space } = c.req.valid("json");
    const { db, config } = c.var;
    const { files, orgId } = writeDoor(c);
    if (size > config.STORAGE_MAX_FILE_BYTES || partCount(size) > STORAGE_MAX_PARTS) {
      return apiError(c, "file_too_large", "the file is larger than one file may be");
    }
    const { limitBytes } = await storageLimit(db, config, orgId);
    const opened = await files.openUpload(placeOf({ parentId, space }), {
      name,
      size,
      mimeType,
      limitBytes,
      sha256,
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
    const bucket = c.env.STORAGE_BUCKET;
    const upload = await findUpload(c, c.req.param("id"));
    if (!upload) return refused(c, "not_found");
    if (!upload.nodeId) {
      if (!live(upload)) return refused(c, "not_found");
      if (upload.parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
        return refused(c, "incomplete");
      }
      await finishObject(bucket, upload);
    }
    const { limitBytes } = await storageLimit(db, config, upload.orgId);
    const done = await files.completeUpload(upload.id, { limitBytes, ifContentVersion });
    if (done.status === "ok") {
      announceDrives(c, [done.node]);
      return c.json({ node: wireNode(done.node) } satisfies StorageNodeResponse);
    }
    const aborted = await files.abortUpload(upload.id);
    if (aborted.status === "ok") {
      await bucket.delete(aborted.r2Key).catch((error: unknown) => {
        log.error("storage.objects_left", { count: 1, error });
      });
    }
    if (done.status === "version_conflict") return staleSave(c, done.contentVersion);
    return refused(c, done.status);
  })

  .delete("/uploads/:id", async (c) => {
    const aborted = await writeDoor(c).files.abortUpload(c.req.param("id"));
    if (aborted.status !== "ok") return refused(c, aborted.status);
    await abortMultipart(c.env.STORAGE_BUCKET, aborted.r2Key, aborted.r2UploadId);
    return c.body(null, 204);
  });
