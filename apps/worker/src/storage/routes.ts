// Storage's member routes (ADR 0034 decision 6), under `/api/storage`: browse the active
// workspace's My files and Shared, Trash, unlocking a file, download and usage; the changes are in
// `changes.ts` and sharing in `sharing.ts`. Everything goes through
// `forMember(member).storage`, which decides access; nothing here queries a storage table.
// Every change is a write, so a read-only workspace (ADR 0015) answers it `402 billing_inactive`
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
import { extraGb, storageLimit, wireNode } from "./core.ts";
import { zValidator } from "../validator.ts";
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
import { storageSharing } from "./sharing.ts";

const trashCursor = z.object({ trashedAt: z.coerce.date(), id: z.string().min(1) });

/**
 * The reads a sync client shares with the app: a folder's contents, a file's bytes, and usage.
 * Mounted here and again under `/api/storage/sync/:orgId` (`sync.ts`).
 */
export const storageReads = new Hono<AppEnv>()
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
    const { limitBytes, allowanceBytes, overagePeriodStart } = limit;
    const full = limitBytes !== null && usedBytes + reservedBytes >= limitBytes;
    // The month's peak as the daily job last recorded it, or what is stored now if that is more.
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

  .post("/nodes/:id/restore", async (c) => {
    const restored = await memberStorage(c).restore(c.req.param("id"));
    if (restored.status !== "ok") return refused(c, restored.status);
    return c.json({ node: wireNode(restored.node) } satisfies StorageNodeResponse);
  })

  /** Unlocks a file (ADR 0036 decision 6). Owners and admins only; anyone else gets `403`. */
  .delete("/nodes/:id/lock", async (c) => {
    const unlocked = await memberStorage(c).unlock(c.req.param("id"));
    if (unlocked.status !== "ok") return refused(c, unlocked.status);
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

  .route("/", storageSharing)
  .route("/", storageChanges);
