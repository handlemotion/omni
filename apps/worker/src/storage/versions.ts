import {
  storageOpenVersionBodySchema,
  type StorageNodeResponse,
  type StorageUploadResponse,
  type StorageVersionsResponse,
} from "@omni/contracts";
import { STORAGE_VERSION_DAYS, type StorageContent } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announceDrives } from "./announce.ts";
import { storageLimit, wireNode, wireUpload } from "./core.ts";
import { download, refused, staleSave, writeDoor } from "./http.ts";
import { restoreLive } from "./restore-live.ts";
import { startObject, tooLarge, uploadCaps } from "./uploads.ts";

const wireContent = (content: StorageContent) => ({
  size: content.size,
  mimeType: content.mimeType,
  writtenAt: content.writtenAt.toISOString(),
  writtenByName: content.writtenByName,
  writtenByAgent: content.writtenByAgent,
  writtenByGuest: content.writtenByGuest,
  coauthors: content.coauthors,
});

export const storageVersions = new Hono<AppEnv>()
  .post("/files/:id/versions", zValidator("json", storageOpenVersionBodySchema), async (c) => {
    const { size, mimeType, sha256, ifContentVersion } = c.req.valid("json");
    const { db, config } = c.var;
    const { files, orgId } = writeDoor(c);
    const refusedSize = tooLarge(c, size);
    if (refusedSize) return refusedSize;
    const { limitBytes } = await storageLimit(db, config, orgId);
    const opened = await files.openVersionUpload(c.req.param("id"), {
      size,
      mimeType,
      sha256,
      ifContentVersion,
      limitBytes,
      caps: uploadCaps(config),
    });
    if (opened.status === "version_conflict") return staleSave(c, opened.contentVersion);
    if (opened.status !== "ok") return refused(c, opened.status);
    const started = await startObject(c, files, opened.upload);
    return c.json({ upload: wireUpload(started) } satisfies StorageUploadResponse, 201);
  })

  .get("/files/:id/versions", async (c) => {
    const listed = await writeDoor(c).files.versions(c.req.param("id"));
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      current: wireContent(listed.current),
      versions: listed.versions.map((version) => ({
        ...wireContent(version),
        id: version.id,
        replacedAt: version.replacedAt.toISOString(),
      })),
      keepDays: STORAGE_VERSION_DAYS,
    } satisfies StorageVersionsResponse);
  })

  .get("/files/:id/versions/:versionId/content", async (c) => {
    const { id, versionId } = c.req.param();
    return download(c, await writeDoor(c).files.versionFile(id, versionId));
  })

  .post("/files/:id/versions/:versionId/restore", async (c) => {
    const { id, versionId } = c.req.param();
    const live = await restoreLive(c, id, versionId);
    if (live) return live;
    const restored = await writeDoor(c).files.restoreVersion(id, versionId);
    if (restored.status !== "ok") return refused(c, restored.status);
    announceDrives(c, [restored.node]);
    return c.json({ node: wireNode(restored.node) } satisfies StorageNodeResponse);
  });
