import { talkFileQuerySchema, type TalkMessageResponse } from "@omni/contracts";
import { forUser, type MemberStorage } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { announceDrives } from "../storage/announce.ts";
import { deleteStorageObjects, storageLimit } from "../storage/core.ts";
import { memberStorage, refused as storageRefused } from "../storage/http.ts";
import { zValidator } from "../validator.ts";
import { deliver, memberTalk, refused, wireMessage } from "./http.ts";

/** The folder in the sender's My files that drops go into: one shared with nobody else. */
export const TALK_FOLDER = "Talk";
const FOLDER_PAGES = 20;

const TALK_NAME = /^Talk(?: \(?\d+\)?)?$/;

async function isPrivate(files: MemberStorage, folderId: string) {
  const shared = await files.sharing(folderId);
  return (
    shared.status === "ok" &&
    shared.sharing.people.length === 0 &&
    shared.sharing.linkAccess === "restricted"
  );
}

async function talkFolder(files: MemberStorage) {
  let cursor = null;
  for (let page = 0; page < FOLDER_PAGES; page++) {
    const listed = await files.list({ space: "personal" }, { cursor, limit: 200 });
    if (listed.status !== "ok") return null;
    for (const node of listed.nodes) {
      if (
        node.kind === "folder" &&
        TALK_NAME.test(node.name) &&
        (await isPrivate(files, node.id))
      ) {
        return { id: node.id, made: null };
      }
    }
    const pastFolders = listed.nodes.some((node) => node.kind === "file");
    if (pastFolders || !listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  const made = await files.createFolder({ space: "personal" }, TALK_FOLDER);
  return made.status === "ok" ? { id: made.node.id, made: made.node } : null;
}

async function storeFile(
  c: Context<AppEnv>,
  files: MemberStorage,
  parentId: string,
  file: { name: string; size: number; mimeType: string | null },
) {
  const { limitBytes } = await storageLimit(c.var.db, c.var.config, c.var.member.orgId);
  const opened = await files.openUpload({ parentId }, { ...file, limitBytes });
  if (opened.status !== "ok") return opened;
  const { upload } = opened;
  const drop = async () => {
    const aborted = await files.abortUpload(upload.id);
    if (aborted.status === "ok") {
      await deleteStorageObjects(c.env.STORAGE_BUCKET, [aborted.r2Key], c.var.log);
    }
  };
  try {
    const { readable, writable } = new FixedLengthStream(file.size);
    const body = c.req.raw.body;
    const [stored] = await Promise.all([
      c.env.STORAGE_BUCKET.put(upload.r2Key, readable),
      body ? body.pipeTo(writable) : writable.close(),
    ]);
    if (!stored) throw new Error("talk: the file was not stored");
    if (upload.size > 0) {
      const part = { partNumber: 1, etag: stored.etag, size: upload.size };
      const recorded = await files.recordUploadPart(upload.id, part);
      if (recorded.status !== "ok") throw new Error(`talk: part ${recorded.status}`);
    }
  } catch (error) {
    await drop();
    throw error;
  }
  const done = await files.completeUpload(upload.id, { limitBytes });
  if (done.status !== "ok") await drop();
  return done;
}

async function takeBack(c: Context<AppEnv>, files: MemberStorage, nodeId: string) {
  const trashed = await files.trash(nodeId);
  const deleted = trashed.status === "ok" ? await files.deleteForever(nodeId) : null;
  if (deleted?.status === "ok") {
    await deleteStorageObjects(c.env.STORAGE_BUCKET, deleted.r2Keys, c.var.log);
  }
  c.var.log.warn("talk.file_taken_back", { nodeId });
}

async function openFile(c: Context<AppEnv>) {
  const file = await memberTalk(c).fileOf(c.req.param("id") ?? "");
  if (file.status !== "ok") return refused(c, file);
  const query = new URL(c.req.url).search;
  if (file.sent) {
    const own = await memberStorage(c).node(file.nodeId);
    if (!own) return refused(c, { status: "not_found" });
    return c.redirect(`/api/storage/files/${file.nodeId}/content${query}`, 302);
  }
  const { user } = c.var;
  const shareId = await forUser(c.var.db, user.id, user.scopeOrgId).storage.linkOf(file.nodeId);
  if (!shareId) return refused(c, { status: "not_found" });
  return c.redirect(`/api/storage/shared/${shareId}/files/${file.nodeId}/content${query}`, 302);
}

export const talkFiles = new Hono<AppEnv>()
  .get("/messages/:id/file", openFile)
  .post("/threads/:id/files", zValidator("query", talkFileQuerySchema), async (c) => {
    const talk = memberTalk(c);
    const found = await talk.thread(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    const size = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(size) || size < 0) {
      return apiError(c, "length_required", "send the file's content-length");
    }
    const max = c.var.config.STORAGE_MAX_FILE_BYTES;
    if (max !== undefined && size > max) {
      return apiError(c, "file_too_large", "the file is larger than one file may be");
    }
    const files = memberStorage(c);
    const folder = await talkFolder(files);
    if (!folder) return apiError(c, "forbidden", "you cannot keep files here");
    const parentId = folder.id;
    const mimeType = c.req.header("content-type")?.split(";")[0]?.trim() || null;
    const name = c.req.valid("query").name;
    const done = await storeFile(c, files, parentId, { name, size, mimeType });
    if (done.status !== "ok") return storageRefused(c, done.status);
    const { node } = done;
    const shared = await files.putGrant(node.id, found.other.shareTo, "viewer");
    const sent =
      shared.status === "ok"
        ? await talk.recordFile(found.thread.id, {
            nodeId: node.id,
            name: node.name,
            size: node.size,
            mimeType: node.mimeType,
          })
        : shared;
    if (sent.status !== "ok") {
      await takeBack(c, files, node.id);
      return sent.status === "not_found" || sent.status === "no_talk"
        ? refused(c, sent)
        : storageRefused(c, sent.status);
    }
    announceDrives(c, [folder.made, node]);
    deliver(c, sent.thread, sent.message);
    return c.json({ message: wireMessage(sent.message) } satisfies TalkMessageResponse, 201);
  });
