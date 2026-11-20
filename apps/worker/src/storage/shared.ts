import { storageSharedQuerySchema, type StorageSharedResponse } from "@omni/contracts";
import {
  forMember,
  forUser,
  publicStorage,
  type MemberStorage,
  type SharedStorage,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { inGoodStanding, READ_ONLY_MESSAGE } from "../billing.ts";
import { findMemberIds, resolveSession, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { checkRateLimit, clientIp, tooManyRequests } from "../rate-limiter.ts";
import { wireNode } from "./core.ts";
import { zValidator } from "../validator.ts";
import { storageChanges } from "./changes.ts";
import {
  decodeCursor,
  download,
  encodeCursor,
  listCursor,
  refused,
  wireView,
  type SharedAccess,
} from "./http.ts";
import { thumbnail } from "./thumbnails.ts";
import { zip } from "./zip.ts";

const through: (root: SharedAccess["root"], door: MemberStorage | SharedStorage) => SharedAccess = (
  root,
  door,
) => {
  return {
    root,
    node: door.node,
    list: (parentId, page) => door.list({ parentId }, page),
    file: door.file,
    archive: door.archive,
    writer: door,
  };
};

const openShared: (c: Context<AppEnv>, shareId: string) => Promise<SharedAccess | null> = async (
  c,
  shareId,
) => {
  const { db } = c.var;
  const session = await resolveSession(c);
  if (session) {
    const { id, scopeOrgId } = session.user;
    for (const memberId of await findMemberIds(db, id, scopeOrgId)) {
      const door = forMember(db, memberId).storage;
      const root = await door.nodeByShareId(shareId);
      if (root) return through(root, door);
    }
    const granted = forUser(db, id, scopeOrgId).storage.under(shareId);
    const root = await granted.nodeByShareId(shareId);
    if (root) return through(root, granted);
  }
  const link = publicStorage(db, shareId);
  const root = await link.node();
  if (!root) return null;
  return {
    root,
    node: (nodeId) => link.node(nodeId),
    list: (parentId, page) => link.list({ parentId, ...page }),
    file: link.file,
    archive: link.archive,
    writer: null,
  };
};

const open = createMiddleware<AppEnv>(async (c, next) => {
  const { db, config } = c.var;
  const wait = await checkRateLimit(c.env, config, "storageLink", clientIp(c.req.raw));
  if (wait) return tooManyRequests(c, wait, "storageLink");

  const shared = await openShared(c, c.req.param("shareId") ?? "");
  if (!shared) return refused(c, "not_found");
  c.set("shared", shared);
  const { root } = shared;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (!shared.writer) return refused(c, "forbidden");
    if (!(await inGoodStanding(db, config, root.node.orgId))) {
      return apiError(c, "billing_inactive", READ_ONLY_MESSAGE);
    }
  }
  await next();
});

export const storageShared = new Hono<AppEnv>()
  .use("/:shareId/*", open)

  .get("/:shareId", zValidator("query", storageSharedQuerySchema), async (c) => {
    const { node, cursor, limit } = c.req.valid("query");
    const shared = c.var.shared!;
    const item = node ? await shared.node(node) : shared.root;
    if (!item) return refused(c, "not_found");
    if (item.node.kind !== "folder") {
      return c.json({
        item: wireView(item),
        nodes: [],
        nextCursor: null,
      } satisfies StorageSharedResponse);
    }
    const listed = await shared.list(item.node.id, {
      cursor: decodeCursor(cursor, listCursor),
      limit,
    });
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      item: wireView(item),
      nodes: listed.nodes.map(wireNode),
      nextCursor: encodeCursor(listed.nextCursor),
    } satisfies StorageSharedResponse);
  })

  .get("/:shareId/files/:id/content", async (c) =>
    download(c, await c.var.shared!.file(c.req.param("id"))),
  )

  .get("/:shareId/files/:id/thumbnail", async (c) =>
    thumbnail(c, await c.var.shared!.file(c.req.param("id"))),
  )

  .get("/:shareId/zip", (c) => {
    const shared = c.var.shared!;
    return zip(c, shared.archive, shared.root.node.id);
  })

  .route("/:shareId", storageChanges);
