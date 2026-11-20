import type { Db, MemberStorage, StorageNode, StoragePlace } from "@omni/db";
import type { Config } from "../env.ts";
import type { Logger } from "../log.ts";
import { announceTo } from "./announce.ts";
import { storageLimit } from "./core.ts";
import { uploadCaps } from "./uploads.ts";

/** What writing a file from the Worker needs. */
export interface WriteDeps {
  env: Env;
  db: Db;
  config: Config;
  log: Logger;
  waitUntil: (work: Promise<unknown>) => void;
}

const MARKDOWN = "text/markdown";

/** A write's outcome: the file, a newer version in the way, or why it was refused. */
export type WriteResult =
  | { status: "ok"; node: StorageNode }
  | { status: "version_conflict"; contentVersion: number | null }
  | { status: "refused"; reason: string };

const failed = (result: { status: string; contentVersion?: number }) =>
  (result.status === "version_conflict"
    ? { status: "version_conflict", contentVersion: result.contentVersion ?? null }
    : { status: "refused", reason: result.status }) satisfies WriteResult;

/**
 * Writes `text` as a new file at `place`, or as the next version of `nodeId` when the file is
 * still at `ifContentVersion`, through the same upload rows, quota and checks as the app's own
 * uploads. Answers the file, or why it was refused.
 */
export async function writeText(
  deps: WriteDeps,
  files: MemberStorage,
  orgId: string,
  target: { place: StoragePlace; name: string } | { nodeId: string; ifContentVersion: number },
  text: string,
) {
  const bytes = new TextEncoder().encode(text);
  const { limitBytes } = await storageLimit(deps.db, deps.config, orgId);
  const caps = uploadCaps(deps.config);
  const opened =
    "place" in target
      ? await files.openUpload(target.place, {
          name: target.name,
          size: bytes.byteLength,
          mimeType: MARKDOWN,
          limitBytes,
          caps,
        })
      : await files.openVersionUpload(target.nodeId, {
          size: bytes.byteLength,
          mimeType: MARKDOWN,
          limitBytes,
          ifContentVersion: target.ifContentVersion,
          caps,
        });
  if (opened.status !== "ok") return failed(opened) as WriteResult;
  const { upload } = opened;
  const bucket = deps.env.STORAGE_BUCKET;
  try {
    await putObject(bucket, files, upload, bytes);
    const done = await files.completeUpload(upload.id, {
      limitBytes,
      ifContentVersion: "nodeId" in target ? target.ifContentVersion : null,
    });
    if (done.status !== "ok") {
      await dropUpload(deps, files, upload.id);
      return failed(done);
    }
    announceTo(deps, [done.node]);
    return { status: "ok", node: done.node } satisfies WriteResult;
  } catch (error) {
    await dropUpload(deps, files, upload.id);
    throw error;
  }
}

/**
 * Whether `text` could be written now as the next version of `nodeId` (quota, upload caps, its
 * version), checked by opening that upload and dropping it: a refusal, or null when it fits.
 */
export async function refusalFor(
  deps: WriteDeps,
  files: MemberStorage,
  orgId: string,
  target: { nodeId: string; ifContentVersion: number },
  text: string,
) {
  const { limitBytes } = await storageLimit(deps.db, deps.config, orgId);
  const opened = await files.openVersionUpload(target.nodeId, {
    size: new TextEncoder().encode(text).byteLength,
    mimeType: MARKDOWN,
    limitBytes,
    ifContentVersion: target.ifContentVersion,
    caps: uploadCaps(deps.config),
  });
  if (opened.status !== "ok") return failed(opened) as WriteResult;
  await dropUpload(deps, files, opened.upload.id);
  return null;
}

async function putObject(
  bucket: R2Bucket,
  files: MemberStorage,
  upload: { id: string; r2Key: string },
  bytes: Uint8Array,
) {
  if (bytes.byteLength === 0) {
    await bucket.put(upload.r2Key, bytes);
    return;
  }
  const multipart = await bucket.createMultipartUpload(upload.r2Key);
  const started = await files.startUpload(upload.id, multipart.uploadId);
  if (!started) throw new Error("storage: the upload was gone before it started");
  const { etag } = await multipart.uploadPart(1, bytes);
  const recorded = await files.recordUploadPart(upload.id, {
    partNumber: 1,
    etag,
    size: bytes.byteLength,
  });
  if (recorded.status !== "ok") throw new Error("storage: the part was not recorded");
  await multipart.complete([{ partNumber: 1, etag }]);
}

async function dropUpload(deps: WriteDeps, files: MemberStorage, uploadId: string) {
  const aborted = await files.abortUpload(uploadId).catch(() => null);
  if (aborted?.status !== "ok") return;
  await deps.env.STORAGE_BUCKET.delete(aborted.r2Key).catch((error: unknown) => {
    deps.log.error("storage.objects_left", { count: 1, error });
  });
}
