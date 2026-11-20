import { linkKeyMatches, linkPasswordMatches, signLinkKey } from "@omni/crypto";
import {
  STORAGE_LINK_KEY_HEADER,
  storageSharedQuerySchema,
  storageUnlockBodySchema,
  type StorageNodeView,
  type StorageSharedResponse,
  type StorageUnlockResponse,
} from "@omni/contracts";
import {
  forMember,
  forUser,
  linkOf,
  linkState,
  publicStorage,
  recordShareEvent,
  type LinkVisitor,
  type MemberStorage,
  type ShareEventInput,
  type SharedStorage,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { inGoodStanding, READ_ONLY_MESSAGE } from "../billing.ts";
import { findMemberIds, resolveSession, type AppEnv, type SessionUser } from "../context.ts";
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

const UNLOCK_MS = 12 * 60 * 60 * 1000;
const COOKIE = "omni_link_key";
const cookiePath = (shareId: string) => `/api/storage/shared/${encodeURIComponent(shareId)}`;

const through: (
  root: SharedAccess["root"],
  door: MemberStorage | SharedStorage,
  via: "member" | "grant",
) => SharedAccess = (root, door, via) => {
  return {
    root,
    node: door.node,
    list: (parentId, page) => door.list({ parentId }, page),
    file: door.file,
    archive: door.archive,
    writer: door,
    via,
    downloads: true,
  };
};

const presentedKey = (c: Context<AppEnv>) =>
  c.req.header(STORAGE_LINK_KEY_HEADER) ?? getCookie(c, COOKIE) ?? null;

function visitorOf(c: Context<AppEnv>, user: SessionUser | null) {
  const key = presentedKey(c);
  const secret = c.var.config.auth.secret;
  return {
    userId: user?.id ?? null,
    scopeOrgId: user?.scopeOrgId ?? null,
    unlocked: async (link: { shareId: string; passwordHash: string }) =>
      key ? linkKeyMatches(secret, link, key) : false,
  } satisfies LinkVisitor;
}

type Opened =
  | { status: "ok"; shared: SharedAccess }
  | { status: "locked" }
  | { status: "not_found" };

const openShared: (
  c: Context<AppEnv>,
  shareId: string,
  user: SessionUser | null,
) => Promise<Opened> = async (c, shareId, user) => {
  const { db } = c.var;
  if (user) {
    const { id, scopeOrgId } = user;
    for (const memberId of await findMemberIds(db, id, scopeOrgId)) {
      const door = forMember(db, memberId).storage;
      const root = await door.nodeByShareId(shareId);
      if (root) return { status: "ok", shared: through(root, door, "member") };
    }
    const granted = forUser(db, id, scopeOrgId).storage.under(shareId);
    const root = await granted.nodeByShareId(shareId);
    if (root) return { status: "ok", shared: through(root, granted, "grant") };
  }
  const visitor = visitorOf(c, user);
  const link = publicStorage(db, shareId, visitor);
  const root = await link.node();
  if (!root) {
    const node = await linkOf(db, shareId);
    const locked = node && !node.trashedAt && (await linkState(db, node, visitor)) === "locked";
    return locked ? { status: "locked" } : { status: "not_found" };
  }
  const settings = await linkOf(db, shareId);
  return {
    status: "ok",
    shared: {
      root,
      node: (nodeId) => link.node(nodeId),
      list: (parentId, page) => link.list({ parentId, ...page }),
      file: link.file,
      archive: link.archive,
      writer: null,
      via: "link",
      downloads: settings?.linkDownloads ?? false,
    },
  };
};

const visitorKey = (c: Context<AppEnv>, user: SessionUser | null) =>
  user ? `user:${user.id}` : `ip:${clientIp(c.req.raw)}`;

const open = createMiddleware<AppEnv>(async (c, next) => {
  const { db, config } = c.var;
  const user = (await resolveSession(c))?.user ?? null;
  const wait = await checkRateLimit(c.env, config, "storageLink", visitorKey(c, user));
  if (wait) return tooManyRequests(c, wait, "storageLink");

  const opened = await openShared(c, c.req.param("shareId") ?? "", user);
  if (opened.status === "locked") {
    return apiError(c, "link_locked", "this link needs its password");
  }
  if (opened.status !== "ok") return refused(c, "not_found");
  const { shared } = opened;
  c.set("shared", shared);
  c.set("linkUser", user);
  const { root } = shared;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (!shared.writer) return refused(c, "forbidden");
    if (!(await inGoodStanding(db, config, root.node.orgId))) {
      return apiError(c, "billing_inactive", READ_ONLY_MESSAGE);
    }
  }
  await next();
});

function publicView(view: StorageNodeView) {
  return {
    ...view,
    node: {
      ...view.node,
      orgId: "",
      ownerMemberId: null,
      createdByMemberId: null,
      contentSha256: null,
    },
  } satisfies StorageNodeView;
}

async function audit(
  c: Context<AppEnv>,
  kind: ShareEventInput["kind"],
  nodeId: string,
  detail: Record<string, unknown> = {},
) {
  const shared = c.var.shared!;
  const user = c.var.linkUser ?? null;
  await recordShareEvent(c.var.db, {
    orgId: shared.root.node.orgId,
    nodeId,
    kind,
    via: shared.via,
    actorUserId: user?.id ?? null,
    detail: { shareNodeId: shared.root.node.id, ...detail },
  });
}

const startsDownload = (range: string | undefined) => !range || range.trim().startsWith("bytes=0-");

export const storageShared = new Hono<AppEnv>()
  .post("/:shareId/unlock", zValidator("json", storageUnlockBodySchema), async (c) => {
    const { db, config } = c.var;
    const shareId = c.req.param("shareId");
    const user = (await resolveSession(c))?.user ?? null;
    const wait = await checkRateLimit(
      c.env,
      config,
      "storageLinkPassword",
      `${shareId}:${visitorKey(c, user)}`,
    );
    if (wait) return tooManyRequests(c, wait, "storageLinkPassword");
    const node = await linkOf(db, shareId);
    const visitor = { ...visitorOf(c, user), unlocked: async () => false };
    const lockedNow =
      node?.shareId && node.linkPasswordHash && !node.trashedAt
        ? (await linkState(db, node, visitor)) === "locked"
        : false;
    if (!lockedNow || !node?.shareId || !node.linkPasswordHash) return refused(c, "not_found");
    const link = { shareId: node.shareId, passwordHash: node.linkPasswordHash };
    if (!(await linkPasswordMatches(c.req.valid("json").password, link.passwordHash))) {
      return apiError(c, "wrong_password", "that is not the link's password");
    }
    const expiresAt = new Date(Date.now() + UNLOCK_MS);
    const key = await signLinkKey(config.auth.secret, link, expiresAt);
    setCookie(c, COOKIE, key, {
      path: cookiePath(shareId),
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      expires: expiresAt,
    });
    return c.json({ key, expiresAt: expiresAt.toISOString() } satisfies StorageUnlockResponse);
  })

  .delete("/:shareId/unlock", (c) => {
    deleteCookie(c, COOKIE, { path: cookiePath(c.req.param("shareId")) });
    return c.body(null, 204);
  })

  .use("/:shareId/*", open)

  .get("/:shareId", zValidator("query", storageSharedQuerySchema), async (c) => {
    const { node, cursor, limit } = c.req.valid("query");
    const shared = c.var.shared!;
    const item = node ? await shared.node(node) : shared.root;
    if (!item) return refused(c, "not_found");
    const show = (view: StorageNodeView) => (shared.via === "link" ? publicView(view) : view);
    if (!cursor) await audit(c, "viewed", item.node.id);
    if (item.node.kind !== "folder") {
      return c.json({
        item: show(wireView(item)),
        nodes: [],
        nextCursor: null,
        downloads: shared.downloads,
      } satisfies StorageSharedResponse);
    }
    const listed = await shared.list(item.node.id, {
      cursor: decodeCursor(cursor, listCursor),
      limit,
    });
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      item: show(wireView(item)),
      nodes: listed.nodes
        .map(wireNode)
        .map((wired) =>
          shared.via === "link"
            ? publicView({ node: wired, role: "viewer", path: [] }).node
            : wired,
        ),
      nextCursor: encodeCursor(listed.nextCursor),
      downloads: shared.downloads,
    } satisfies StorageSharedResponse);
  })

  .get("/:shareId/files/:id/content", async (c) => {
    const shared = c.var.shared!;
    if (!shared.downloads) return apiError(c, "forbidden", "this link is view only");
    const found = await shared.file(c.req.param("id"));
    const response = await download(c, found);
    const counted = c.req.method === "GET" && startsDownload(c.req.header("range"));
    if (found.status === "ok" && response.ok && counted) {
      await audit(c, "downloaded", found.file.id);
    }
    return response;
  })

  .get("/:shareId/files/:id/thumbnail", async (c) =>
    thumbnail(c, await c.var.shared!.file(c.req.param("id"))),
  )

  .get("/:shareId/zip", async (c) => {
    const shared = c.var.shared!;
    if (!shared.downloads) return apiError(c, "forbidden", "this link is view only");
    const response = await zip(c, shared.archive, shared.root.node.id);
    if (response.ok) await audit(c, "downloaded", shared.root.node.id, { zip: true });
    return response;
  })

  .route("/:shareId", storageChanges);
