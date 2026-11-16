// The link door (ADR 0034 decisions 3, 4 and 6), under `/api/storage/shared/:shareId`: what
// `/s/<shareId>` opens. A session is optional. Without one, only a link open to anyone answers,
// and only to list and download. With one, a member of the item's workspace who reaches it there
// gets in as a member, and a person it was shared with by the grant door bounded to this link;
// both change what they may through the same routes a member uses (`storage-changes.ts`). Everything else is `404`, a Restricted link
// included: the answer never says whether a link exists.
//
// Mounted ahead of the member API, so the checks a member route gets from middleware are made
// here: the rate limit is per IP (`RATE_LIMIT_STORAGE_LINK`), and a change needs the shared
// node's workspace in good standing (ADR 0015), whatever workspace the person's own is.
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
import { wireNode } from "../storage.ts";
import { zValidator } from "../validator.ts";
import { storageChanges } from "./storage-changes.ts";
import {
  decodeCursor,
  download,
  encodeCursor,
  listCursor,
  refused,
  wireView,
  type SharedAccess,
} from "./storage-http.ts";

/** A member's or a grantee's door as the link door's routes read through it. */
function through(root: SharedAccess["root"], door: MemberStorage | SharedStorage): SharedAccess {
  return {
    root,
    node: door.node,
    list: (parentId, page) => door.list({ parentId }, page),
    file: door.file,
    writer: door,
  };
}

/**
 * What `shareId` opens for this request, by the first door that opens it: the member door of a
 * workspace the session may use (a teammate's link to something in Shared, or one's own file),
 * then a grant, then the link itself when it is open to anyone. Null when none does.
 */
async function openShared(c: Context<AppEnv>, shareId: string): Promise<SharedAccess | null> {
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
    writer: null,
  };
}

const open = createMiddleware<AppEnv>(async (c, next) => {
  const { db, config } = c.var;
  const wait = await checkRateLimit(c.env, config, "storageLink", clientIp(c.req.raw));
  if (wait) return tooManyRequests(c, wait, "storageLink");

  const shared = await openShared(c, c.req.param("shareId") ?? "");
  if (!shared) return refused(c, "not_found");
  c.set("shared", shared);
  const { root } = shared;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // A link alone never writes: an anonymous editor would be an open upload endpoint.
    if (!shared.writer) return refused(c, "forbidden");
    if (!(await inGoodStanding(db, config, root.node.orgId))) {
      return apiError(c, "billing_inactive", READ_ONLY_MESSAGE);
    }
  }
  await next();
});

export const storageShared = new Hono<AppEnv>()
  .use("/:shareId/*", open)

  /** The shared node, or `?node=` inside it, and a folder's contents. */
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

  /** A shared file's bytes: the same download a member gets. */
  .get("/:shareId/files/:id/content", async (c) =>
    download(c, await c.var.shared!.file(c.req.param("id"))),
  )

  .route("/:shareId", storageChanges);
