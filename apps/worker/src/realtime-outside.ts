import { storageNodeSpaceSchema, type StorageDocEvent } from "@omni/contracts";
import { linkKeyMatches } from "@omni/crypto";
import { isDocFile } from "@omni/docs/file";
import { guestName, presenceSlot, type PresenceUser } from "@omni/docs/presence";
import { forUser, publicStorage, recordShareEvent, type StorageNodeView } from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "./billing.ts";
import { openDb } from "./db.ts";
import { loadConfig } from "./env.ts";
import { attachmentOf, editingOf, type Editing } from "./realtime-files.ts";

/**
 * Set (by the Worker, never the client) on a socket opened through a share link
 * (`docs/spec/live-sharing.md`): JSON of `OutsideOpening`. Such a socket edits one doc, is tagged
 * `out:<nodeId>` and `who:<by>`, and hears that doc's records, presence and comments alone.
 */
export const OUTSIDE_HEADER = "x-omni-outside";

export const outsideTag = (nodeId: string) => `out:${nodeId}`;
const whoTag = (by: string) => `who:${by}`;

/** Within this long of its last check, an outsider's message is taken on that check. */
export const OUTSIDE_CHECK_MS = 2000;
/** Every outsider is checked again this often while connected, whatever they send. */
export const OUTSIDE_SWEEP_MS = 10_000;

const CAPS = { perDoc: 50, perOrg: 200, perPerson: 5 } as const;

export const outsideOpening = z.object({
  door: z.enum(["grant", "link"]),
  shareId: z.string().min(1),
  orgId: z.string().min(1),
  nodeId: z.string().min(1),
  space: storageNodeSpaceSchema,
  ownerMemberId: z.string().nullable(),
  locked: z.boolean(),
  role: z.enum(["editor", "commenter"]),
  writable: z.boolean(),
  /** A grantee's user and session scope. */
  userId: z.string().nullable(),
  scopeOrgId: z.string().nullable(),
  /** A guest's id, from their guest key. */
  guestId: z.string().nullable(),
  /** The grantee's name; a guest's is made from their id. */
  name: z.string().max(200),
  /** The password key that unlocked the link, checked again on every recheck. */
  linkKey: z.string().nullable(),
  /** When the door closes on its own (the link's expiry, the key's), in ms; null for never. */
  endsAt: z.number().nullable(),
});
export type OutsideOpening = z.infer<typeof outsideOpening>;

/** What an outsider socket's attachment holds beside the file it edits. */
export interface Outside {
  door: "grant" | "link";
  shareId: string;
  orgId: string;
  role: "editor" | "commenter";
  writable: boolean;
  userId: string | null;
  scopeOrgId: string | null;
  guestId: string | null;
  linkKey: string | null;
  endsAt: number | null;
  /** `u:<userId>` or `g:<guestId>`: what its records are stamped with. */
  by: string;
  user: PresenceUser;
}

export const outsideOf = (socket: WebSocket) =>
  (attachmentOf(socket)?.outside as Outside | undefined) ?? null;

export const isOutsider = (ctx: DurableObjectState, socket: WebSocket) =>
  ctx.getTags(socket)[0]?.startsWith("out:") ?? false;

/** Every outsider socket the object holds. */
export const allOutsiders = (ctx: DurableObjectState) =>
  ctx.getWebSockets().filter((socket) => isOutsider(ctx, socket));

export const outsidersOn = (ctx: DurableObjectState, nodeId: string) =>
  ctx.getWebSockets(outsideTag(nodeId));

const send = (socket: WebSocket, event: StorageDocEvent) => {
  try {
    socket.send(JSON.stringify(event));
  } catch {}
};

/** A record as an outsider hears it: without `by`, which may hold a member id. */
export function forOutsiders(event: StorageDocEvent) {
  if (event.type !== "doc.record" || event.record.t !== "update" || !event.record.by) return event;
  const { by: _by, ...record } = event.record;
  return { ...event, record } satisfies StorageDocEvent;
}

/** Sends `events` to the outsiders on the doc but `except`, `by` taken off. */
export function sendToOutsiders(
  ctx: DurableObjectState,
  nodeId: string,
  events: StorageDocEvent[],
  except?: WebSocket,
) {
  const sockets = outsidersOn(ctx, nodeId).filter((socket) => socket !== except);
  if (sockets.length === 0) return;
  const messages = events.map((event) => JSON.stringify(forOutsiders(event)));
  for (const socket of sockets) {
    for (const message of messages) {
      try {
        socket.send(message);
      } catch {}
    }
  }
}

/**
 * Takes an outsider's socket, when the doc, the workspace and the person have room for one
 * more: the Worker opened it through the link's door and says who it is.
 */
export function acceptOutside(ctx: DurableObjectState, opening: OutsideOpening) {
  const by = opening.door === "grant" ? `u:${opening.userId}` : `g:${opening.guestId}`;
  const everyone = allOutsiders(ctx);
  if (
    everyone.length >= CAPS.perOrg ||
    outsidersOn(ctx, opening.nodeId).length >= CAPS.perDoc ||
    ctx.getWebSockets(whoTag(by)).length >= CAPS.perPerson
  ) {
    return new Response("too many people on this link", { status: 429 });
  }
  const { 0: client, 1: server } = new WebSocketPair();
  ctx.acceptWebSocket(server, [outsideTag(opening.nodeId), whoTag(by)]);
  const id = opening.door === "grant" ? opening.userId! : opening.guestId!;
  const outside: Outside = {
    door: opening.door,
    shareId: opening.shareId,
    orgId: opening.orgId,
    role: opening.role,
    writable: opening.writable,
    userId: opening.userId,
    scopeOrgId: opening.scopeOrgId,
    guestId: opening.guestId,
    linkKey: opening.linkKey,
    endsAt: opening.endsAt,
    by,
    user: {
      name: opening.door === "grant" ? opening.name : guestName(id),
      slot: presenceSlot(id),
      kind: opening.door === "grant" ? "grantee" : "guest",
    },
  };
  const file: Editing = {
    nodeId: opening.nodeId,
    space: opening.space,
    ownerMemberId: opening.ownerMemberId,
    locked: opening.locked,
    checkedAt: Date.now(),
  };
  server.serializeAttachment({ file, outside });
  return new Response(null, { status: 101, webSocket: client });
}

type Checked = { file: Editing; role: Outside["role"]; writable: boolean } | null;

const roleOf = (view: StorageNodeView) =>
  view.role === "editor" || view.role === "member"
    ? "editor"
    : view.role === "commenter"
      ? "commenter"
      : null;

/** The doc as the outsider's door reaches it now; null when it no longer opens it to them. */
export const checkOutside: (
  env: Env,
  outside: Outside,
  nodeId: string,
) => Promise<Checked> = async (env, outside, nodeId) => {
  if (outside.endsAt !== null && outside.endsAt <= Date.now()) return null;
  const config = loadConfig(env);
  const { db, close } = openDb(env, 1);
  try {
    const view =
      outside.door === "grant" && outside.userId
        ? await forUser(db, outside.userId, outside.scopeOrgId)
            .storage.under(outside.shareId)
            .node(nodeId)
        : await publicStorage(db, outside.shareId, {
            unlocked: async (link) =>
              !!outside.linkKey &&
              (await linkKeyMatches(config.auth.secret, link, outside.linkKey)),
          }).node(nodeId);
    const node = view?.node;
    const role = view ? roleOf(view) : null;
    if (!node || !role || view.inTrash || !isDocFile(node.name, node.mimeType)) return null;
    return {
      role,
      writable: await inGoodStanding(db, config, node.orgId),
      file: {
        nodeId,
        space: node.space,
        ownerMemberId: node.ownerMemberId,
        locked: !!node.lockedAt,
        checkedAt: Date.now(),
      },
    };
  } finally {
    await close({ timeout: 0 });
  }
};

/**
 * Checks the outsider's door again and keeps what it says: a changed role is told
 * (`doc.access`), and a door that no longer opens closes the socket (`4403`). Answers whether the
 * socket is still on the doc.
 */
export async function recheckOutsider(env: Env, socket: WebSocket) {
  const outside = outsideOf(socket);
  const at = editingOf(socket);
  if (!outside || !at) return false;
  const now = await checkOutside(env, outside, at.nodeId);
  if (!now) {
    send(socket, { type: "doc.access", nodeId: at.nodeId, role: null });
    try {
      socket.close(4403, "access ended");
    } catch {}
    return false;
  }
  socket.serializeAttachment({
    ...attachmentOf(socket),
    file: now.file,
    outside: { ...outside, role: now.role, writable: now.writable },
  });
  if (now.role !== outside.role)
    send(socket, { type: "doc.access", nodeId: at.nodeId, role: now.role });
  return true;
}

/** Rechecks the outsiders on these docs, or every one: after a change that may narrow access. */
export async function recheckOutsiders(
  ctx: DurableObjectState,
  env: Env,
  nodeIds: string[] | "all",
) {
  const sockets =
    nodeIds === "all"
      ? allOutsiders(ctx)
      : [...new Set(nodeIds)].flatMap((nodeId) => outsidersOn(ctx, nodeId));
  await Promise.all(sockets.map((socket) => recheckOutsider(env, socket)));
}

const lastEdited = new WeakMap<WebSocket, number>();
const EDITED_GAP_MS = 10 * 60_000;

/**
 * Records in the sharing audit trail that an outsider edited the doc: once per socket, and again
 * after ten minutes without an edit.
 */
export async function noteEdited(env: Env, socket: WebSocket, nodeId: string) {
  const outside = outsideOf(socket);
  if (!outside) return;
  const now = Date.now();
  const last = lastEdited.get(socket);
  lastEdited.set(socket, now);
  if (last !== undefined && now - last < EDITED_GAP_MS) return;
  const { db, close } = openDb(env, 1);
  try {
    await recordShareEvent(db, {
      orgId: outside.orgId,
      nodeId,
      kind: "edited",
      via: outside.door,
      actorUserId: outside.userId,
      detail: {
        shareId: outside.shareId,
        ...(outside.guestId ? { guest: { id: outside.guestId, name: outside.user.name } } : {}),
      },
    });
  } finally {
    await close({ timeout: 0 });
  }
}

/**
 * Opens an outsider's socket from the opening the Worker vouched for (`OUTSIDE_HEADER`); `opened`
 * runs once it is taken.
 */
export async function openOutside(
  ctx: DurableObjectState,
  request: Request,
  header: string,
  opened: () => Promise<void>,
) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  const opening = outsideOpening.safeParse(JSON.parse(header));
  if (!opening.success) return new Response("bad outside opening", { status: 400 });
  const response = acceptOutside(ctx, opening.data);
  if (response.status === 101) await opened();
  return response;
}
