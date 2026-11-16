// The routes that change files and folders (ADR 0034 decision 6): create a folder, rename, move,
// trash, and upload. Written once against `writeDoor` and mounted twice: under `/api/storage`
// for a member in their workspace, and under `/api/storage/shared/:shareId` for a person an
// item was shared with as Editor, where the grant door bounds every one of them to that item.
import {
  storageChangeNodeBodySchema,
  storageCreateFolderBodySchema,
  storageDeleteQuerySchema,
  type StorageNodeResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { deleteStorageObjects, wireNode } from "../storage.ts";
import { zValidator } from "../validator.ts";
import { placeOf, refused, writeDoor } from "./storage-http.ts";
import { storageUploads } from "./storage-uploads.ts";

export const storageChanges = new Hono<AppEnv>()
  .post("/folders", zValidator("json", storageCreateFolderBodySchema), async (c) => {
    const { name, parentId, space } = c.req.valid("json");
    const made = await writeDoor(c).files.createFolder(placeOf({ parentId, space }), name);
    if (made.status !== "ok") return refused(c, made.status);
    return c.json({ node: wireNode(made.node) } satisfies StorageNodeResponse, 201);
  })

  /** A new name, or a new place: another folder, or the root of My files or Shared. */
  .patch("/nodes/:id", zValidator("json", storageChangeNodeBodySchema), async (c) => {
    const body = c.req.valid("json");
    const id = c.req.param("id");
    const { files } = writeDoor(c);
    const changed =
      "name" in body ? await files.rename(id, body.name) : await files.move(id, placeOf(body));
    if (changed.status !== "ok") return refused(c, changed.status);
    return c.json({ node: wireNode(changed.node) } satisfies StorageNodeResponse);
  })

  /** To Trash. With `?forever=1`, out of Trash for good: rows first, then the objects. */
  .delete("/nodes/:id", zValidator("query", storageDeleteQuerySchema), async (c) => {
    const id = c.req.param("id");
    const { files } = writeDoor(c);
    if (!c.req.valid("query").forever) {
      const trashed = await files.trash(id);
      if (trashed.status !== "ok") return refused(c, trashed.status);
      return c.json({ node: wireNode(trashed.node) } satisfies StorageNodeResponse);
    }
    // Trash is its space's members' alone: a grant reaches nothing in it.
    if (!("deleteForever" in files)) return refused(c, "not_found");
    const deleted = await files.deleteForever(id);
    if (deleted.status !== "ok") return refused(c, deleted.status);
    await deleteStorageObjects(c.env.STORAGE_BUCKET, deleted.r2Keys, c.var.log);
    return c.body(null, 204);
  })

  .route("/", storageUploads);
