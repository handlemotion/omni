import {
  createUpload,
  deleteUnsentUpload,
  memberMailbox,
  memberUpload,
  newUploadId,
  uploadKey,
} from "@omni/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError, notFound } from "../errors.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { attachmentResponse } from "./assets.ts";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const uploadQuery = z.object({
  mailboxId: z.string().min(1),
  filename: z.string().trim().min(1).max(255),
});

/** Files a composer attaches before the send: kept a day, until a send takes them. */
export const uploads = new Hono<AppEnv>()
  .post("/uploads", limitPerMember("actions"), zValidator("query", uploadQuery), async (c) => {
    const { mailboxId, filename } = c.req.valid("query");
    const size = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) {
      return apiError(c, "length_required", "content-length required");
    }
    if (size > c.var.config.UPLOAD_MAX_BYTES) {
      return apiError(
        c,
        "payload_too_large",
        `file is larger than ${c.var.config.UPLOAD_MAX_BYTES} bytes`,
      );
    }
    const body = c.req.raw.body;
    if (!body) return apiError(c, "bad_request", "empty body");
    const mailbox = await memberMailbox(c.var.db, c.var.member.id, mailboxId);
    if (!mailbox) notFound();

    const id = newUploadId();
    const r2Key = uploadKey({ orgId: mailbox.orgId, mailboxId, id });
    const mimeType =
      c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const { readable, writable } = new FixedLengthStream(size);
    const [stored] = await Promise.all([
      c.env.MAIL_BUCKET.put(r2Key, readable, { httpMetadata: { contentType: mimeType } }),
      body.pipeTo(writable),
    ]);
    if (!stored) throw new Error("upload was not stored");
    const upload = await createUpload(c.var.db, {
      id,
      orgId: mailbox.orgId,
      mailboxId,
      memberId: c.var.member.id,
      filename,
      mimeType,
      size,
      r2Key,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    });
    return c.json(
      {
        id: upload.id,
        filename: upload.filename,
        mimeType: upload.mimeType,
        size: upload.size,
        expiresAt: upload.expiresAt,
      },
      201,
    );
  })

  .get("/uploads/:id", async (c) => {
    const upload = await memberUpload(c.var.db, c.var.member.id, c.req.param("id"));
    if (!upload) notFound();
    const object = await c.env.MAIL_BUCKET.get(upload.r2Key);
    if (!object) notFound();
    return attachmentResponse(object, upload);
  })

  .delete("/uploads/:id", async (c) => {
    const r2Key = await deleteUnsentUpload(c.var.db, c.var.member.id, c.req.param("id"));
    if (!r2Key) notFound();
    c.executionCtx.waitUntil(c.env.MAIL_BUCKET.delete(r2Key));
    return c.body(null, 204);
  });
