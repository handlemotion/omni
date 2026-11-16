// Uploads (ADR 0034 decision 5): R2 multipart through the Worker's binding, one code path for
// every size. Open checks the quota and opens the multipart upload; each part streams from the
// request into R2; complete closes it and inserts the file. The upload's row lists the parts the
// bucket has, so a part can be sent again, parts can go in parallel, and a dropped connection
// resumes from `GET /uploads/:id`. Completing twice returns the same file.
import {
  STORAGE_MAX_PARTS,
  storageOpenUploadBodySchema,
  type StorageNodeResponse,
  type StorageUploadResponse,
} from "@omni/contracts";
import type { StorageUpload } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import {
  abortMultipart,
  partCount,
  partLength,
  storageLimit,
  wireNode,
  wireUpload,
} from "../storage.ts";
import { zValidator } from "../validator.ts";
import { fail, memberStorage, placeOf, refused } from "./storage-http.ts";

const live = (upload: StorageUpload) => upload.expiresAt > new Date();
const answer = (upload: StorageUpload) =>
  ({ upload: wireUpload(upload) }) satisfies StorageUploadResponse;

/**
 * Turns the parts into the object. An earlier try may have done so and lost its answer (the
 * bucket then no longer knows the upload): the object being there, whole, is the proof.
 */
async function finishObject(bucket: R2Bucket, upload: StorageUpload) {
  // R2 has no multipart upload without a part: an empty file is one plain put.
  if (!upload.r2UploadId) return bucket.put(upload.r2Key, new Uint8Array(0));
  try {
    const parts = upload.parts.map(({ partNumber, etag }) => ({ partNumber, etag }));
    await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).complete(parts);
  } catch (error) {
    const object = await bucket.head(upload.r2Key);
    if (object?.size !== upload.size) throw error;
  }
}

/** Checks a part against its upload, streams it into the bucket and records it. */
async function storePart(c: Context<AppEnv>, body: ReadableStream | null) {
  const n = Number(c.req.param("n"));
  const upload = await memberStorage(c).upload(c.req.param("id") ?? "");
  if (!upload || (!upload.nodeId && !live(upload))) return refused(c, "not_found");
  if (upload.nodeId) return fail(c, 409, "UPLOAD_COMPLETE", "the upload is already a file");
  if (n < 1 || n > partCount(upload.size) || !upload.r2UploadId) {
    return fail(c, 400, "INVALID_PART", `the upload has ${partCount(upload.size)} parts`);
  }
  const expected = partLength(upload.size, n);
  // R2 streams a body only when its length is known, and parts must be uniform.
  if (!body || Number(c.req.header("content-length")) !== expected) {
    return fail(c, 400, "INVALID_PART", `part ${n} must be exactly ${expected} bytes`);
  }
  const multipart = c.env.STORAGE_BUCKET.resumeMultipartUpload(upload.r2Key, upload.r2UploadId);
  let etag: string;
  try {
    ({ etag } = await multipart.uploadPart(n, body));
  } catch (error) {
    // Aborted or completed while the part was on its way: there is nothing to add it to.
    const now = await memberStorage(c).upload(upload.id);
    if (!now || now.nodeId) return refused(c, "not_found");
    throw error;
  }
  const recorded = await memberStorage(c).recordUploadPart(upload.id, {
    partNumber: n,
    etag,
    size: expected,
  });
  if (recorded.status !== "ok") return refused(c, recorded.status);
  return c.json(answer(recorded.upload));
}

export const storageUploads = new Hono<AppEnv>()
  .post("/uploads", zValidator("json", storageOpenUploadBodySchema), async (c) => {
    const { name, size, mimeType, parentId, space } = c.req.valid("json");
    const { db, config, member } = c.var;
    if (size > config.STORAGE_MAX_FILE_BYTES || partCount(size) > STORAGE_MAX_PARTS) {
      return fail(c, 413, "FILE_TOO_LARGE", "the file is larger than one file may be");
    }
    const { limitBytes } = await storageLimit(db, config, member.orgId);
    const opened = await memberStorage(c).openUpload(placeOf({ parentId, space }), {
      name,
      size,
      mimeType,
      limitBytes,
    });
    if (opened.status !== "ok") return refused(c, opened.status);
    if (size === 0) return c.json(answer(opened.upload), 201);
    try {
      const multipart = await c.env.STORAGE_BUCKET.createMultipartUpload(opened.upload.r2Key);
      const started = await memberStorage(c).startUpload(opened.upload.id, multipart.uploadId);
      if (!started) throw new Error("storage: the upload was gone before it started");
      return c.json(answer(started), 201);
    } catch (error) {
      // Nothing may keep holding room for an upload that cannot receive a part.
      await memberStorage(c).abortUpload(opened.upload.id);
      throw error;
    }
  })

  /** The upload and the parts already stored: what a client reads to resume. */
  .get("/uploads/:id", async (c) => {
    const upload = await memberStorage(c).upload(c.req.param("id"));
    if (!upload || (!upload.nodeId && !live(upload))) return refused(c, "not_found");
    return c.json(answer(upload));
  })

  /** One part's raw bytes, streamed into R2. Its length is fixed by its number. */
  .put("/uploads/:id/parts/:n{[0-9]+}", async (c) => {
    const body = c.req.raw.body;
    const stored = await storePart(c, body);
    // A refused part was not read. Read it out, or the sender, still sending, sees a broken
    // connection instead of the answer.
    if (body && !body.locked) await body.pipeTo(new WritableStream()).catch(() => {});
    return stored;
  })

  .post("/uploads/:id/complete", async (c) => {
    const { db, config, member, log } = c.var;
    const bucket = c.env.STORAGE_BUCKET;
    const upload = await memberStorage(c).upload(c.req.param("id"));
    if (!upload) return refused(c, "not_found");
    if (!upload.nodeId) {
      if (!live(upload)) return refused(c, "not_found");
      if (upload.parts.reduce((sum, part) => sum + part.size, 0) !== upload.size) {
        return refused(c, "incomplete");
      }
      await finishObject(bucket, upload);
    }
    const { limitBytes } = await storageLimit(db, config, member.orgId);
    const done = await memberStorage(c).completeUpload(upload.id, { limitBytes });
    if (done.status === "ok") {
      return c.json({ node: wireNode(done.node) } satisfies StorageNodeResponse);
    }
    // No file came of it (no room any more, the folder is gone): nothing stays stored. Only an
    // upload that never became a file loses its bytes. A completed one is a file, which someone
    // may hold even when this caller no longer reaches it (it was moved out of Shared), and
    // `abortUpload` refuses it: the object goes only with the row that was its sole owner.
    const aborted = await memberStorage(c).abortUpload(upload.id);
    if (aborted.status === "ok") {
      await bucket.delete(aborted.r2Key).catch((error: unknown) => {
        log.error("storage.objects_left", { count: 1, error });
      });
    }
    return refused(c, done.status);
  })

  .delete("/uploads/:id", async (c) => {
    const aborted = await memberStorage(c).abortUpload(c.req.param("id"));
    if (aborted.status !== "ok") return refused(c, aborted.status);
    await abortMultipart(c.env.STORAGE_BUCKET, aborted.r2Key, aborted.r2UploadId);
    return c.body(null, 204);
  });
