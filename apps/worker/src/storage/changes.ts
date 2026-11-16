// The routes that change files and folders (ADR 0034 decision 6): create a folder, rename, move,
// trash, upload, and a file's versions and comments. Written once against `writeDoor` and
// mounted twice: under `/api/storage` for a member in their workspace, and under
// `/api/storage/shared/:shareId` for a person an item was shared with, where the grant door
// bounds every one of them to that item.
import {
  storageChangeNodeBodySchema,
  storageCreateFolderBodySchema,
  storageDeleteQuerySchema,
  storageRevisionGuardQuerySchema,
  type StorageNodeResponse,
} from "@omni/contracts";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiFailure } from "../errors.ts";
import { announceDrives } from "./announce.ts";
import { deleteStorageObjects, wireNode } from "./core.ts";
import { zValidator } from "../validator.ts";
import { placeOf, refused, writeDoor } from "./http.ts";
import { storageComments } from "./comments.ts";
import { storageUploads } from "./uploads.ts";
import { storageVersions } from "./versions.ts";

/**
 * The `?ifRevision=` guard of a change, read by hand rather than by a validator: the app's typed
 * client would then have to send a query it never uses.
 */
function guardOf(c: Context<AppEnv>) {
  const parsed = storageRevisionGuardQuerySchema.safeParse({
    ifRevision: c.req.query("ifRevision"),
  });
  if (!parsed.success) throw new ApiFailure("bad_request", "ifRevision must be a whole number");
  return parsed.data;
}

export const storageChanges = new Hono<AppEnv>()
  .post("/folders", zValidator("json", storageCreateFolderBodySchema), async (c) => {
    const { name, parentId, space } = c.req.valid("json");
    const made = await writeDoor(c).files.createFolder(placeOf({ parentId, space }), name);
    if (made.status !== "ok") return refused(c, made.status);
    announceDrives(c, [made.node]);
    return c.json({ node: wireNode(made.node) } satisfies StorageNodeResponse, 201);
  })

  /** A new name, or a new place: another folder, or the root of My files or Shared. */
  /** With `?ifRevision=`, refused `409 version_conflict` when the node has changed since. */
  .patch("/nodes/:id", zValidator("json", storageChangeNodeBodySchema), async (c) => {
    const body = c.req.valid("json");
    const guard = guardOf(c);
    const id = c.req.param("id");
    const { files } = writeDoor(c);
    if ("name" in body) {
      const renamed = await files.rename(id, body.name, guard);
      if (renamed.status !== "ok") return refused(c, renamed.status);
      announceDrives(c, [renamed.node]);
      return c.json({ node: wireNode(renamed.node) } satisfies StorageNodeResponse);
    }
    const changed = await files.move(id, placeOf(body), guard);
    if (changed.status !== "ok") return refused(c, changed.status);
    // Out of one drive into another: both hear of it.
    announceDrives(c, [changed.node, changed.left]);
    return c.json({ node: wireNode(changed.node) } satisfies StorageNodeResponse);
  })

  /**
   * To Trash, guarded like a change by `?ifRevision=`. With `?forever=1`, out of Trash for good:
   * rows first, then the objects.
   */
  .delete(
    "/nodes/:id",
    zValidator("query", storageDeleteQuerySchema.extend(storageRevisionGuardQuerySchema.shape)),
    async (c) => {
      const id = c.req.param("id");
      const { files } = writeDoor(c);
      const query = c.req.valid("query");
      if (!query.forever) {
        const trashed = await files.trash(id, { ifRevision: query.ifRevision });
        if (trashed.status !== "ok") return refused(c, trashed.status);
        announceDrives(c, [trashed.node]);
        return c.json({ node: wireNode(trashed.node) } satisfies StorageNodeResponse);
      }
      // Trash is its space's members' alone: a grant reaches nothing in it.
      if (!("deleteForever" in files)) return refused(c, "not_found");
      const deleted = await files.deleteForever(id);
      if (deleted.status !== "ok") return refused(c, deleted.status);
      announceDrives(c, [deleted.drive]);
      await deleteStorageObjects(c.env.STORAGE_BUCKET, deleted.r2Keys, c.var.log);
      return c.body(null, 204);
    },
  )

  .route("/", storageUploads)
  .route("/", storageVersions)
  .route("/", storageComments);
