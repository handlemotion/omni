// Storage's member routes (ADR 0034 decision 6), under `/api/storage`: browse the active
// workspace's My files and Shared, Trash, download and usage; the changes are in
// `storage-changes.ts` and sharing in `storage-sharing.ts`. Everything goes through
// `forMember(member).storage`, which decides access; nothing here queries a storage table.
// Every change is a write, so a read-only workspace (ADR 0015) answers it `402 BILLING_INACTIVE`
// in `requireWritableWorkspace` and keeps listing and downloading.
import {
  storageListQuerySchema,
  storagePageQuerySchema,
  type StorageListResponse,
  type StorageNodeResponse,
  type StorageTrashResponse,
  type StorageUsage,
} from "@omni/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { storageLimit, wireNode } from "../storage.ts";
import { zValidator } from "../validator.ts";
import { storageChanges } from "./storage-changes.ts";
import {
  decodeCursor,
  download,
  encodeCursor,
  listCursor,
  memberStorage,
  placeOf,
  refused,
  wireView,
} from "./storage-http.ts";
import { storageSharing } from "./storage-sharing.ts";

const trashCursor = z.object({ trashedAt: z.coerce.date(), id: z.string().min(1) });

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
    return download(c, await memberStorage(c).file(c.req.param("id")));
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

  .route("/", storageSharing)
  .route("/", storageChanges);
