import {
  storageListQuerySchema,
  storagePageQuerySchema,
  storageFolderIconsQuerySchema,
  storageSearchQuerySchema,
  type StorageFindResponse,
  type StorageFolderIconsResponse,
  type StorageListResponse,
  type StorageNodeResponse,
  type StorageTrashResponse,
  type StorageUsage,
} from "@omni/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { extraGb, storageLimit, wireNode } from "./core.ts";
import { zValidator } from "../validator.ts";
import { announceDrives } from "./announce.ts";
import { storageChanges } from "./changes.ts";
import {
  decodeCursor,
  download,
  encodeCursor,
  listCursor,
  memberStorage,
  placeOf,
  refused,
  wireView,
} from "./http.ts";
import { storageLive } from "./live.ts";
import { storageSharing } from "./sharing.ts";
import { storageTeamspaces } from "./teamspaces.ts";
import { storageSigningMember } from "./signing.ts";
import { thumbnail } from "./thumbnails.ts";
import { zip } from "./zip.ts";

const trashCursor = z.object({ trashedAt: z.coerce.date(), id: z.string().min(1) });

/**
 * The reads a sync client shares with the app: a folder's contents, a file's bytes, and usage.
 * Mounted here and again under `/api/storage/sync/:orgId` (`sync.ts`).
 */
export const storageReads = new Hono<AppEnv>()
  .get("/nodes", zValidator("query", storageListQuerySchema), async (c) => {
    const { space, teamspace, parent, cursor, limit } = c.req.valid("query");
    const place = placeOf({ parentId: parent, space, teamspaceId: teamspace });
    const listed = await memberStorage(c).list(place, {
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

  .get("/files/:id/content", async (c) => {
    return download(c, await memberStorage(c).file(c.req.param("id")));
  })

  .get("/files/:id/thumbnail", async (c) => {
    return thumbnail(c, await memberStorage(c).file(c.req.param("id")));
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
    const { limitBytes, allowanceBytes, overagePeriodStart } = limit;
    const full = limitBytes !== null && usedBytes + reservedBytes >= limitBytes;
    const peak =
      overagePeriodStart && allowanceBytes !== null
        ? Math.max(usedBytes, (await memberStorage(c).peak(overagePeriodStart)) ?? 0)
        : null;
    return c.json({
      usedBytes,
      reservedBytes,
      limitBytes,
      allowanceBytes,
      overage: peak === null ? null : { extraGb: extraGb(peak, allowanceBytes!) },
      uploadsBlocked: writable ? (full ? "storage_full" : null) : "billing_inactive",
    } satisfies StorageUsage);
  });

export const storage = new Hono<AppEnv>()
  .route("/", storageReads)
  .get("/nodes/:id", async (c) => {
    const view = await memberStorage(c).node(c.req.param("id"));
    if (!view || view.inTrash) return refused(c, "not_found");
    return c.json({ node: wireNode(view.node) } satisfies StorageNodeResponse);
  })

  .post("/nodes/:id/restore", async (c) => {
    const restored = await memberStorage(c).restore(c.req.param("id"));
    if (restored.status !== "ok") return refused(c, restored.status);
    announceDrives(c, [restored.node]);
    return c.json({ node: wireNode(restored.node) } satisfies StorageNodeResponse);
  })

  .delete("/nodes/:id/lock", async (c) => {
    const unlocked = await memberStorage(c).unlock(c.req.param("id"));
    if (unlocked.status !== "ok") return refused(c, unlocked.status);
    announceDrives(c, [unlocked.node]);
    return c.json({ node: wireNode(unlocked.node) } satisfies StorageNodeResponse);
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

  .on(["GET", "POST"], "/zip", (c) => zip(c, memberStorage(c).archive))

  .get("/search", zValidator("query", storageSearchQuerySchema), async (c) => {
    const { q, drive, type } = c.req.valid("query");
    const nodes = await memberStorage(c).search(q, { teamOnly: drive === "team", type });
    return c.json({ nodes: nodes.map(wireNode) } satisfies StorageFindResponse);
  })

  .get("/recent", async (c) => {
    const nodes = await memberStorage(c).recent();
    return c.json({ nodes: nodes.map(wireNode) } satisfies StorageFindResponse);
  })

  .get("/icons", zValidator("query", storageFolderIconsQuerySchema), async (c) => {
    const { space, teamspace } = c.req.valid("query");
    const icons = await memberStorage(c).folderIcons(
      teamspace ? { teamspaceId: teamspace } : (space ?? "personal"),
    );
    return c.json({ icons } satisfies StorageFolderIconsResponse);
  })

  .route("/", storageTeamspaces)
  .route("/", storageLive)
  .route("/", storageSharing)
  .route("/", storageSigningMember)
  .route("/", storageChanges);
