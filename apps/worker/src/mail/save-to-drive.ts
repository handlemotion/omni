// Save to drive (ADR 0039 decision 3): one attachment copied once into Storage, nothing kept in
// sync. A route that spans two modules lives with the one whose screen starts it (ADR 0035
// decision 4): Mail's door says whether the member can open the attachment, and Storage's member
// door files the copy through the same steps as an upload (open, bytes, complete), so its quota,
// naming and usage apply, and an interrupted copy is cleaned up by the expired-upload job.
import { mailSaveToDriveBodySchema, type StorageNodeResponse } from "@omni/contracts";
import { findMemberAttachment } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { storageLimit, wireNode } from "../storage/core.ts";
import { memberStorage, placeOf, refused } from "../storage/http.ts";
import { optionalJsonBody } from "../validator.ts";

/** Streams the object into the storage bucket under `key`: never whole in the Worker's memory. */
async function copyObject(c: Context<AppEnv>, object: R2ObjectBody, key: string) {
  const { readable, writable } = new FixedLengthStream(object.size);
  const [stored] = await Promise.all([
    c.env.STORAGE_BUCKET.put(key, readable),
    object.body.pipeTo(writable),
  ]);
  if (!stored) throw new Error("save to drive: the copy was not stored");
  return stored;
}

export const saveToDrive = new Hono<AppEnv>().post(
  "/mail/attachments/:id/save-to-drive",
  async (c) => {
    const { parentId } = await optionalJsonBody(c, mailSaveToDriveBodySchema);
    const { db, config, member, log } = c.var;
    const attachment = await findMemberAttachment(db, member.id, c.req.param("id"));
    if (!attachment) return apiError(c, "not_found", "not found");
    // The size the bucket holds is the size the upload declares, so the parts add up.
    const object = await c.env.MAIL_BUCKET.get(attachment.r2Key);
    if (!object) {
      log.error("mail.attachment_missing", { orgId: attachment.orgId, id: attachment.id });
      return apiError(c, "not_found", "not found");
    }
    if (
      config.STORAGE_MAX_FILE_BYTES !== undefined &&
      object.size > config.STORAGE_MAX_FILE_BYTES
    ) {
      await object.body.cancel();
      return apiError(c, "file_too_large", "the file is larger than one file may be");
    }
    const files = memberStorage(c);
    // The quota is checked before a byte is copied, and the room held while they are.
    const { limitBytes } = await storageLimit(db, config, member.orgId);
    const opened = await files.openUpload(placeOf({ parentId }), {
      name: attachment.filename,
      size: object.size,
      mimeType: attachment.mimeType,
      limitBytes,
    });
    if (opened.status !== "ok") {
      await object.body.cancel();
      return refused(c, opened.status);
    }
    const { upload } = opened;
    const drop = async () => {
      const aborted = await files.abortUpload(upload.id);
      if (aborted.status !== "ok") return;
      await c.env.STORAGE_BUCKET.delete(aborted.r2Key).catch((error: unknown) => {
        log.error("storage.objects_left", { count: 1, error });
      });
    };
    try {
      const stored = await copyObject(c, object, upload.r2Key);
      // One put holds the whole file: it is recorded as the upload's only part.
      if (upload.size > 0) {
        const part = { partNumber: 1, etag: stored.etag, size: upload.size };
        const recorded = await files.recordUploadPart(upload.id, part);
        if (recorded.status !== "ok") throw new Error(`save to drive: part ${recorded.status}`);
      }
    } catch (error) {
      await drop();
      throw error;
    }
    // The folder and the room are checked again: either may have changed during the copy.
    const done = await files.completeUpload(upload.id, { limitBytes });
    if (done.status !== "ok") {
      await drop();
      return refused(c, done.status);
    }
    return c.json({ node: wireNode(done.node) } satisfies StorageNodeResponse, 201);
  },
);
