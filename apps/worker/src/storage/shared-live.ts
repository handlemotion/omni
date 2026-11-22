import {
  storageLiveReadQuerySchema,
  type StorageLiveEntry,
  type StorageLiveReadResponse,
  type StorageLiveRecord,
} from "@omni/contracts";
import { linkOf, type SharedAccess, type StorageNodeView } from "@omni/db";
import { rewriteLive } from "@omni/docs";
import { isDocFile } from "@omni/docs/file";
import { Hono, type Context } from "hono";
import * as Y from "yjs";
import { inGoodStanding } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { checkRateLimit, clientIp, tooManyRequests } from "../rate-limiter.ts";
import { docStream } from "../realtime-docs.ts";
import { OUTSIDE_HEADER, type OutsideOpening } from "../realtime-outside.ts";
import { s2Basin, type S2Basin } from "../s2.ts";
import { zValidator } from "../validator.ts";
import { LiveFile } from "./doc-live.ts";
import { refused } from "./http.ts";
import { latestLiveStart, readLivePage } from "./live-read.ts";
import { guestFrom, presentedKey } from "./shared-keys.ts";

/**
 * Whether this reader joins the item's live document through the link
 * (`docs/spec/live-sharing.md`): an outsider who edits or comments on a doc that is not locked,
 * with the live layer on. A member joins through `/api/realtime` instead.
 */
export function liveOnPage(c: Context<AppEnv>, shared: SharedAccess, item: StorageNodeView) {
  const { node } = item;
  return (
    !!s2Basin(c.var.config) &&
    shared.via !== "member" &&
    (item.role === "editor" || item.role === "commenter") &&
    node.kind === "file" &&
    !item.inTrash &&
    !node.lockedAt &&
    isDocFile(node.name, node.mimeType)
  );
}

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

async function seedFor(
  c: Context<AppEnv>,
  basin: S2Basin,
  file: { id: string; contentVersion: number },
  r2Key: string,
) {
  for (let tries = 0; tries < 2; tries++) {
    const [tail] = await basin.readTail(docStream(file.id), 1);
    const next = tail ? tail.seqNum + 1 : 0;
    if (await LiveFile.open(basin, file.id, file.contentVersion)) return;
    const object = await c.env.STORAGE_BUCKET.get(r2Key);
    const text = object ? await object.text() : "";
    const record: StorageLiveRecord = {
      t: "seed",
      cv: file.contentVersion,
      u: toBase64(rewriteLive(new Y.Doc(), text)),
    };
    if ((await basin.append(docStream(file.id), JSON.stringify(record), next)) !== null) return;
  }
}

const withoutBy = (entry: StorageLiveEntry) => {
  if (!("by" in entry.record)) return entry;
  const { by: _by, ...record } = entry.record as typeof entry.record & { by?: string };
  return { ...entry, record: record as typeof entry.record } satisfies StorageLiveEntry;
};

function sameOrigin(c: Context<AppEnv>) {
  const origin = c.req.header("origin");
  const { auth } = c.var.config;
  return (
    origin === undefined ||
    new Set([new URL(auth.baseURL).origin, ...auth.trustedOrigins]).has(origin)
  );
}

async function endsAt(c: Context<AppEnv>, shareId: string) {
  const link = await linkOf(c.var.db, shareId);
  const key = presentedKey(c);
  const keyEnds = key && /^\d+\./.test(key) ? Number(key.split(".")[0]) : null;
  const times = [link?.linkExpiresAt?.getTime() ?? null, keyEnds].filter(
    (time): time is number => time !== null,
  );
  return times.length > 0 ? Math.min(...times) : null;
}

async function openingFor(c: Context<AppEnv>, shared: SharedAccess, item: StorageNodeView) {
  const shareId = c.req.param("shareId") ?? "";
  const user = c.var.linkUser ?? null;
  const grant = shared.via === "grant";
  const guest = grant ? null : await guestFrom(c, shareId);
  if (grant ? !user : !guest) return null;
  const { node } = item;
  return {
    door: grant ? "grant" : "link",
    shareId,
    orgId: node.orgId,
    nodeId: node.id,
    space: node.space,
    ownerMemberId: node.ownerMemberId,
    locked: !!node.lockedAt,
    role: item.role === "commenter" ? "commenter" : "editor",
    writable: await inGoodStanding(c.var.db, c.var.config, node.orgId),
    userId: grant ? user!.id : null,
    scopeOrgId: grant ? user!.scopeOrgId : null,
    guestId: guest?.id ?? null,
    name: grant ? (user!.email.split("@")[0] ?? "Someone") : "",
    linkKey: grant ? null : presentedKey(c),
    endsAt: grant ? null : await endsAt(c, shareId),
  } satisfies OutsideOpening;
}

/** Routes under `/shared/:shareId` (after the link's door opened) for a doc's live document. */
export const storageSharedLive = new Hono<AppEnv>()
  .get("/realtime", async (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return apiError(c, "upgrade_required", "expected a websocket upgrade");
    }
    if (!sameOrigin(c)) return apiError(c, "forbidden", "origin not allowed");
    const shared = c.var.shared;
    if (!shared) return refused(c, "not_found");
    if (shared.via === "member") {
      return apiError(c, "use_member_socket", "join through /api/realtime as a member");
    }
    const user = c.var.linkUser ?? null;
    const visitor = user ? `user:${user.id}` : `ip:${clientIp(c.req.raw)}`;
    const wait = await checkRateLimit(c.env, c.var.config, "storageLinkLive", visitor);
    if (wait) return tooManyRequests(c, wait, "storageLinkLive");
    const item = await shared.node(c.req.query("node") ?? shared.root.node.id);
    if (!item || !liveOnPage(c, shared, item)) return refused(c, "not_found");
    const opening = await openingFor(c, shared, item);
    if (!opening) return apiError(c, "forbidden", "open the link first");
    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) {
      if (!name.toLowerCase().startsWith("x-omni-")) headers.set(name, value);
    }
    headers.set(OUTSIDE_HEADER, JSON.stringify(opening));
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(opening.orgId));
    return stub.fetch(new Request(c.req.raw.url, { method: "GET", headers }));
  })

  .get("/files/:id/live", zValidator("query", storageLiveReadQuerySchema), async (c) => {
    const shared = c.var.shared;
    if (!shared) return refused(c, "not_found");
    const basin = s2Basin(c.var.config);
    if (!basin) return c.json({ enabled: false } satisfies StorageLiveReadResponse);
    const item = await shared.node(c.req.param("id"));
    if (!item || (shared.via !== "member" && !liveOnPage(c, shared, item))) {
      return refused(c, "not_found");
    }
    const found = await shared.file(item.node.id);
    if (found.status !== "ok") return refused(c, found.status);
    const asked = c.req.valid("query").from ?? 0;
    if (asked === "latest" && shared.via !== "member") {
      await seedFor(c, basin, found.file, found.r2Key);
    }
    const from = asked === "latest" ? await latestLiveStart(basin, found.file.id) : asked;
    const { entries, more } = await readLivePage(basin, found.file.id, from);
    const shown = shared.via === "member" ? entries : entries.map(withoutBy);
    return c.json({ enabled: true, entries: shown, more } satisfies StorageLiveReadResponse);
  });
