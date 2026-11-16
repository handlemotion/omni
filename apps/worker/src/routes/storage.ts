// Storage's member routes (ADR 0034 decision 6), under `/api/storage`: browse and change the
// active workspace's My files and Shared, Trash, download and usage. Everything goes through
// `forMember(member).storage`, which decides access; nothing here queries a storage table.
// Every change is a write, so a read-only workspace (ADR 0015) answers it `402 BILLING_INACTIVE`
// in `requireWritableWorkspace` and keeps listing and downloading.
import {
  storageChangeNodeBodySchema,
  storageCreateFolderBodySchema,
  storageDeleteQuerySchema,
  storageListQuerySchema,
  storagePageQuerySchema,
  type StorageListResponse,
  type StorageNodeResponse,
  type StorageNodeView,
  type StorageTrashResponse,
  type StorageUsage,
} from "@omni/contracts";
import type { StorageNodeView as NodeViewRow } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { deleteStorageObjects, fileResponse, storageLimit, wireNode } from "../storage.ts";
import { zValidator } from "../validator.ts";
import { memberStorage, placeOf, refused } from "./storage-http.ts";
import { storageUploads } from "./storage-uploads.ts";

/** A cursor travels as base64url JSON: opaque to the client, checked on the way back in. */
function encodeCursor(cursor: unknown) {
  if (!cursor) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor<T extends z.ZodType>(value: string | undefined, schema: T) {
  if (value === undefined) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return schema.parse(JSON.parse(json)) as z.output<T>;
  } catch {
    throw new HTTPException(400, { message: "invalid cursor" });
  }
}

const listCursor = z.object({
  kind: z.enum(["folder", "file"]),
  name: z.string(),
  id: z.string().min(1),
});
const trashCursor = z.object({ trashedAt: z.coerce.date(), id: z.string().min(1) });

const wireView = (view: NodeViewRow): StorageNodeView => ({ ...view, node: wireNode(view.node) });

export const storage = new Hono<AppEnv>()
  .get("/nodes", zValidator("query", storageListQuerySchema), async (c) => {
    const { space, parent, cursor, limit } = c.req.valid("query");
    const listed = await memberStorage(c).list(placeOf({ parentId: parent, space }), {
      cursor: decodeCursor(cursor, listCursor),
      limit,
    });
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      folder: listed.folder && wireView(listed.folder),
      nodes: listed.nodes.map(wireNode),
      nextCursor: encodeCursor(listed.nextCursor),
    } satisfies StorageListResponse);
  })

  .post("/folders", zValidator("json", storageCreateFolderBodySchema), async (c) => {
    const { name, parentId, space } = c.req.valid("json");
    const made = await memberStorage(c).createFolder(placeOf({ parentId, space }), name);
    if (made.status !== "ok") return refused(c, made.status);
    return c.json({ node: wireNode(made.node) } satisfies StorageNodeResponse, 201);
  })

  /** A new name, or a new place: another folder, or the root of My files or Shared. */
  .patch("/nodes/:id", zValidator("json", storageChangeNodeBodySchema), async (c) => {
    const body = c.req.valid("json");
    const id = c.req.param("id");
    const changed =
      "name" in body
        ? await memberStorage(c).rename(id, body.name)
        : await memberStorage(c).move(id, placeOf(body));
    if (changed.status !== "ok") return refused(c, changed.status);
    return c.json({ node: wireNode(changed.node) } satisfies StorageNodeResponse);
  })

  /** To Trash. With `?forever=1`, out of Trash for good: rows first, then the objects. */
  .delete("/nodes/:id", zValidator("query", storageDeleteQuerySchema), async (c) => {
    const id = c.req.param("id");
    if (!c.req.valid("query").forever) {
      const trashed = await memberStorage(c).trash(id);
      if (trashed.status !== "ok") return refused(c, trashed.status);
      return c.json({ node: wireNode(trashed.node) } satisfies StorageNodeResponse);
    }
    const deleted = await memberStorage(c).deleteForever(id);
    if (deleted.status !== "ok") return refused(c, deleted.status);
    await deleteStorageObjects(c.env.STORAGE_BUCKET, deleted.r2Keys, c.var.log);
    return c.body(null, 204);
  })

  .post("/nodes/:id/restore", async (c) => {
    const restored = await memberStorage(c).restore(c.req.param("id"));
    if (restored.status !== "ok") return refused(c, restored.status);
    return c.json({ node: wireNode(restored.node) } satisfies StorageNodeResponse);
  })

  .get("/trash", zValidator("query", storagePageQuerySchema), async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const page = await memberStorage(c).listTrash({
      cursor: decodeCursor(cursor, trashCursor),
      limit,
    });
    return c.json({
      nodes: page.nodes.map(wireNode),
      nextCursor: encodeCursor(page.nextCursor),
    } satisfies StorageTrashResponse);
  })

  /** The file's bytes, always as a download (see `fileResponse`). */
  .get("/files/:id/content", async (c) => {
    const found = await memberStorage(c).file(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    const response = await fileResponse(
      c.env.STORAGE_BUCKET,
      { name: found.file.name, size: found.file.size, r2Key: found.r2Key },
      { range: c.req.header("range"), ifRange: c.req.header("if-range") },
    );
    if (response) return response;
    // The row is the truth and its bytes are gone: someone must know.
    c.var.log.error("storage.object_missing", { orgId: found.file.orgId, nodeId: found.file.id });
    return refused(c, "not_found");
  })

  .get("/usage", async (c) => {
    const { db, config, member } = c.var;
    const [usage, limit, writable] = await Promise.all([
      memberStorage(c).usage(),
      storageLimit(db, config, member.orgId),
      inGoodStanding(db, config, member.orgId),
    ]);
    const usedBytes = usage?.bytes ?? 0;
    const reservedBytes = usage?.reservedBytes ?? 0;
    const full = limit.limitBytes !== null && usedBytes + reservedBytes >= limit.limitBytes;
    return c.json({
      usedBytes,
      reservedBytes,
      ...limit,
      uploadsBlocked: writable ? (full ? "STORAGE_FULL" : null) : "BILLING_INACTIVE",
    } satisfies StorageUsage);
  })

  .route("/", storageUploads);
