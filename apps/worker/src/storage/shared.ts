import { linkKeyMatches, linkPasswordMatches, signLinkKey } from "@omni/crypto";
import {
  storageSharedQuerySchema,
  storageSharedUploadingQuerySchema,
  storageUnlockBodySchema,
  type StorageNodeView,
  type StorageSharedResponse,
  type StorageSharedUpload,
  type StorageSharedUploadingResponse,
  type StorageUnlockResponse,
} from "@omni/contracts";
import {
  forMember,
  forUser,
  linkOf,
  linkState,
  openUploadLink,
  publicStorage,
  recordShareEvent,
  uploadingIn,
  uploadLinkOf,
  type LinkVisitor,
  type MemberStorage,
  type OpenUploadLinkResult,
  type ShareEventInput,
  type SharedStorage,
  type StorageNode,
  type UploadingFile,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
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
import { isOmniCanvas } from "@omni/canvas/file";
import { isDocFile } from "@omni/docs/file";

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

const opensAsPage = (file: StorageNode) =>
  isDocFile(file.name, file.mimeType) || isOmniCanvas(file.mimeType);

async function readsOnPage(shared: Pick<SharedStorage, "file">, file: StorageNode) {
  if (opensAsPage(file)) return true;
  if (!IMAGE_NAME.test(file.name) || !file.parentId) return false;
  const parent = await shared.file(file.parentId);
  return parent.status === "ok" && opensAsPage(parent.file);
}
import { zip } from "./zip.ts";
import { liveOnPage, storageSharedLive } from "./shared-live.ts";
import { COOKIE, cookiePath, guestFrom, mintGuest, presentedKey } from "./shared-keys.ts";

const UNLOCK_MS = 12 * 60 * 60 * 1000;

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
    comments: door,
  };
};

function visitorOf(
  c: Context<AppEnv>,
  user: SessionUser | null,
  guest: LinkVisitor["guest"] = null,
) {
  const key = presentedKey(c);
  const secret = c.var.config.auth.secret;
  return {
    userId: user?.id ?? null,
    scopeOrgId: user?.scopeOrgId ?? null,
    unlocked: async (link: { shareId: string; passwordHash: string }) =>
      key ? linkKeyMatches(secret, link, key) : false,
    guest,
  } satisfies LinkVisitor;
}

type UploadingLink = Extract<OpenUploadLinkResult, { status: "open" }>;

type Opened =
  | { status: "ok"; shared: SharedAccess }
  | { status: "uploading"; link: UploadingLink }
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
  const visitor = visitorOf(c, user, await guestFrom(c, shareId));
  const link = publicStorage(db, shareId, visitor);
  const root = await link.node();
  if (!root) {
    const uploading = await openUploadLink(db, shareId, visitor);
    if (uploading.status === "open") return { status: "uploading", link: uploading };
    if (uploading.status === "locked") return uploading;
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
      comments: link,
    },
  };
};

const readsWhileUploading = (c: Context<AppEnv>) => {
  const prefix = `/shared/${c.req.param("shareId") ?? ""}`;
  const rest = c.req.path.slice(c.req.path.lastIndexOf(prefix) + prefix.length);
  return rest === "" || rest === "/" || rest === "/uploading";
};

const wireUploading = ({ id, name, size, mimeType, uploadedBytes }: UploadingFile) =>
  ({ id, name, size, mimeType, uploadedBytes }) satisfies StorageSharedUpload;

function uploadingView(link: UploadingLink) {
  const { upload } = link;
  const at = upload.createdAt.toISOString();
  return {
    node: {
      id: upload.id,
      orgId: link.via === "link" ? "" : link.orgId,
      space: upload.space,
      ownerMemberId: null,
      parentId: null,
      kind: "file",
      name: upload.name,
      size: upload.size,
      mimeType: upload.mimeType,
      createdByMemberId: null,
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
      lockedAt: null,
      contentSha256: null,
    },
    role: "viewer",
    path: [{ id: upload.id, name: upload.name }],
  } satisfies StorageNodeView;
}

async function uploadingNow(c: Context<AppEnv>, nodeId: string | undefined) {
  const link = c.var.uploadingLink;
  if (link) {
    return nodeId && nodeId !== link.upload.id ? null : [wireUploading(link.upload)];
  }
  const shared = c.var.shared!;
  const item = nodeId ? await shared.node(nodeId) : shared.root;
  if (!item) return null;
  if (item.node.kind !== "folder") return [];
  return (await uploadingIn(c.var.db, item.node.id)).map(wireUploading);
}

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
  if (opened.status === "uploading") {
    if (c.req.method !== "GET" || !readsWhileUploading(c)) return refused(c, "not_found");
    c.set("uploadingLink", opened.link);
    c.set("linkUser", user);
    return next();
  }
  if (opened.status !== "ok") return refused(c, "not_found");
  const { shared } = opened;
  c.set("shared", shared);
  c.set("linkUser", user);
  const { root } = shared;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const commenting = /\/files\/[^/]+\/comments(\/[^/]+)?$/.test(c.req.path);
    if (!shared.writer && !(commenting && shared.comments)) return refused(c, "forbidden");
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
  const shared = c.var.shared;
  const uploading = c.var.uploadingLink;
  const user = c.var.linkUser ?? null;
  await recordShareEvent(c.var.db, {
    orgId: shared?.root.node.orgId ?? uploading!.orgId,
    nodeId,
    kind,
    via: shared?.via ?? uploading!.via,
    actorUserId: user?.id ?? null,
    detail: { shareNodeId: shared?.root.node.id ?? nodeId, ...detail },
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
    const pending = await uploadLinkOf(db, shareId);
    const node = pending
      ? { ...pending.link, orgId: pending.upload.orgId, trashedAt: null }
      : await linkOf(db, shareId);
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

  .get("/:shareId/uploading", zValidator("query", storageSharedUploadingQuerySchema), async (c) => {
    const uploading = await uploadingNow(c, c.req.valid("query").node);
    if (!uploading) return refused(c, "not_found");
    return c.json({ uploading } satisfies StorageSharedUploadingResponse);
  })

  .get("/:shareId", zValidator("query", storageSharedQuerySchema), async (c) => {
    const { node, cursor, limit } = c.req.valid("query");
    const pending = c.var.uploadingLink;
    if (pending) {
      if (node && node !== pending.upload.id) return refused(c, "not_found");
      if (!cursor) await audit(c, "viewed", pending.upload.id, { uploading: true });
      return c.json({
        item: uploadingView(pending),
        nodes: [],
        nextCursor: null,
        downloads: pending.downloads,
        uploading: [wireUploading(pending.upload)],
      } satisfies StorageSharedResponse);
    }
    const shared = c.var.shared!;
    const item = node ? await shared.node(node) : shared.root;
    if (!item) return refused(c, "not_found");
    const show = (view: StorageNodeView) => (shared.via === "link" ? publicView(view) : view);
    if (!cursor) await audit(c, "viewed", item.node.id);
    if (item.node.kind !== "folder") {
      const shareId = c.req.param("shareId");
      const guestly = shared.via === "link" && item.role !== "viewer";
      if (guestly && !(await guestFrom(c, shareId))) await mintGuest(c, shareId);
      const live = liveOnPage(c, shared, item);
      return c.json({
        item: show(wireView(item)),
        nodes: [],
        nextCursor: null,
        downloads: shared.downloads,
        uploading: [],
        live,
      } satisfies StorageSharedResponse);
    }
    const listed = await shared.list(item.node.id, {
      cursor: decodeCursor(cursor, listCursor),
      limit,
    });
    if (listed.status !== "ok") return refused(c, listed.status);
    const uploading = cursor ? [] : await uploadingIn(c.var.db, item.node.id);
    return c.json({
      uploading: uploading.map(wireUploading),
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

  .get("/:shareId/files/:id/view", async (c) => {
    const shared = c.var.shared!;
    const found = await shared.file(c.req.param("id"));
    if (found.status === "ok" && !shared.downloads && !(await readsOnPage(shared, found.file))) {
      return apiError(c, "forbidden", "only a doc or canvas and its images read here");
    }
    return download(c, found);
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

  .route("/:shareId", storageSharedLive)
  .route("/:shareId", storageChanges);
