import type { StorageFilePresenceEvent, StorageNodeSpace } from "@omni/contracts";
import { forMember, teamspaceFileAudience } from "@omni/db";
import { z } from "zod";
import { openDb } from "./db.ts";

/** What an app sends: this socket has the file open in its editor, or closed it. */
export const filePresenceMessage = z.object({
  type: z.literal("file.presence"),
  nodeId: z.string().min(1).max(64),
  state: z.enum(["editing", "left"]),
});
export type FilePresenceMessage = z.infer<typeof filePresenceMessage>;

/** The file a socket is editing, and the drive that says who may hear it. */
export interface Editing {
  nodeId: string;
  space: StorageNodeSpace;
  ownerMemberId: string | null;
  /** In a teamspace: the members who reach it, the only ones told about it. */
  audience?: string[];
  /** Locked when last checked (a signed contract): its live document takes no records. */
  locked?: boolean;
  /** When the member's access was last checked (ms), so an append can tell a stale check. */
  checkedAt?: number;
}

/** Everything a socket's attachment holds: its conversation presence's fields and its file. */
type Attachment = Record<string, unknown> & { file?: Editing };

export const attachmentOf: (socket: WebSocket) => Attachment | null = (socket) => {
  try {
    return (socket.deserializeAttachment() as Attachment | null) ?? null;
  } catch {
    return null;
  }
};

/**
 * Sets the socket's conversation presence (`realtime.ts`), or clears it with null, and keeps the
 * file it edits.
 */
export function setConversation(socket: WebSocket, presence: object | null) {
  const file = attachmentOf(socket)?.file;
  const next = { ...presence, ...(file ? { file } : {}) };
  socket.serializeAttachment(Object.keys(next).length > 0 ? next : null);
}

const latest = new WeakMap<WebSocket, number>();
const nextTurn = (socket: WebSocket) => {
  const turn = (latest.get(socket) ?? 0) + 1;
  latest.set(socket, turn);
  return turn;
};

export const editingOf = (socket: WebSocket) => attachmentOf(socket)?.file ?? null;

const event = (nodeId: string, memberId: string, state: "editing" | "left") =>
  JSON.stringify({
    type: "file.presence",
    nodeId,
    memberId,
    state,
  } satisfies StorageFilePresenceEvent);

/** The app sockets that see the drive: everyone's for Shared, the owner's for My files. */
export function audience(ctx: DurableObjectState, at: Editing) {
  const sockets = at.ownerMemberId ? ctx.getWebSockets(at.ownerMemberId) : ctx.getWebSockets();
  const only = at.space === "teamspace" ? new Set(at.audience ?? []) : null;
  return sockets.filter((socket) => {
    const tag = ctx.getTags(socket)[0];
    if (!tag || tag.startsWith("sync:") || tag.startsWith("watch:")) return false;
    return !only || only.has(tag);
  });
}

function sendAll(sockets: WebSocket[], message: string) {
  for (const socket of sockets) {
    try {
      socket.send(message);
    } catch {}
  }
}

function stillEditing(
  ctx: DurableObjectState,
  memberId: string,
  nodeId: string,
  except: WebSocket,
) {
  return ctx
    .getWebSockets(memberId)
    .some((other) => other !== except && editingOf(other)?.nodeId === nodeId);
}

/** Takes the socket off the file it edits; the others hear `left` unless another tab still edits. */
export function leaveFile(ctx: DurableObjectState, socket: WebSocket, memberId: string) {
  nextTurn(socket);
  const at = editingOf(socket);
  if (!at) return;
  socket.serializeAttachment(withoutFile(socket));
  if (stillEditing(ctx, memberId, at.nodeId, socket)) return;
  const others = audience(ctx, at).filter((other) => ctx.getTags(other)[0] !== memberId);
  sendAll(others, event(at.nodeId, memberId, "left"));
}

function withoutFile(socket: WebSocket) {
  const rest = Object.fromEntries(
    Object.entries(attachmentOf(socket) ?? {}).filter(([key]) => key !== "file"),
  );
  return Object.keys(rest).length > 0 ? rest : null;
}

/** The file as `memberId` reaches it now, or null when they no longer do (or it is in Trash). */
export const checkEditing: (
  env: Env,
  memberId: string,
  nodeId: string,
) => Promise<Editing | null> = async (env, memberId, nodeId) => {
  const { db, close } = openDb(env, 1);
  let found;
  let teamspace: string[] | undefined;
  try {
    found = await forMember(db, memberId).storage.file(nodeId);
    teamspace =
      found.status === "ok" && found.file.teamspaceId
        ? await teamspaceFileAudience(db, found.file.id)
        : undefined;
  } finally {
    await close({ timeout: 0 });
  }
  if (found.status !== "ok" || found.file.trashedAt) return null;
  return {
    nodeId: found.file.id,
    space: found.file.space,
    ownerMemberId: found.file.ownerMemberId,
    ...(teamspace ? { audience: teamspace } : {}),
    locked: !!found.file.lockedAt,
    checkedAt: Date.now(),
  };
};

/** Keeps a fresh check of the file the socket edits (its access, its drive, its lock). */
export function setEditing(socket: WebSocket, at: Editing) {
  socket.serializeAttachment({ ...withoutFile(socket), file: at });
}

/**
 * `editing`: checks the member reaches the file, tells the others who see it (again on each
 * heartbeat), and answers a newcomer with who already edits it. `left`: as `leaveFile`.
 */
export async function onFilePresence(
  ctx: DurableObjectState,
  env: Env,
  socket: WebSocket,
  memberId: string,
  message: FilePresenceMessage,
) {
  const turn = nextTurn(socket);
  if (message.state === "left") {
    if (editingOf(socket)?.nodeId === message.nodeId) leaveFile(ctx, socket, memberId);
    return;
  }
  const at = await checkEditing(env, memberId, message.nodeId);
  if (latest.get(socket) !== turn) return;
  const current = editingOf(socket);
  if (!at) {
    if (current?.nodeId === message.nodeId) leaveFile(ctx, socket, memberId);
    return;
  }
  if (current && current.nodeId !== message.nodeId) leaveFile(ctx, socket, memberId);
  setEditing(socket, at);
  const others = audience(ctx, at).filter((other) => ctx.getTags(other)[0] !== memberId);
  sendAll(others, event(at.nodeId, memberId, "editing"));
  if (current?.nodeId === at.nodeId) return;
  const here = new Set<string>();
  for (const other of others) {
    const them = ctx.getTags(other)[0];
    if (them && editingOf(other)?.nodeId === at.nodeId) here.add(them);
  }
  for (const them of here) sendAll([socket], event(at.nodeId, them, "editing"));
}
