// "Ana is editing" (ADR 0043 decision 3): a socket names the file open in its editor, and the
// others who see that file hear it. Held in the socket's attachment beside its conversation
// presence (`realtime.ts`), so it survives hibernation. A hint, not a lock: the checked save is
// what keeps one person from overwriting another.
import type { StorageFilePresenceEvent, StorageSpace } from "@omni/contracts";
import { forMember } from "@omni/db";
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
interface Editing {
  nodeId: string;
  space: StorageSpace;
  ownerMemberId: string | null;
}

/** Everything a socket's attachment holds: its conversation presence's fields and its file. */
type Attachment = Record<string, unknown> & { file?: Editing };

export function attachmentOf(socket: WebSocket): Attachment | null {
  try {
    return (socket.deserializeAttachment() as Attachment | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sets the socket's conversation presence (`realtime.ts`), or clears it with null, and keeps the
 * file it edits.
 */
export function setConversation(socket: WebSocket, presence: object | null) {
  const file = attachmentOf(socket)?.file;
  const next = { ...presence, ...(file ? { file } : {}) };
  socket.serializeAttachment(Object.keys(next).length > 0 ? next : null);
}

/**
 * Each socket's latest presence message. The access check awaits Postgres, and the object takes
 * the socket's next message meanwhile, so a check that finishes after a newer message (a `left`,
 * another file, the socket closing) is dropped instead of undoing it. Memory only: a hibernated
 * object has no check in flight.
 */
const latest = new WeakMap<WebSocket, number>();
const nextTurn = (socket: WebSocket) => {
  const turn = (latest.get(socket) ?? 0) + 1;
  latest.set(socket, turn);
  return turn;
};

const editingOf = (socket: WebSocket) => attachmentOf(socket)?.file ?? null;

const event = (nodeId: string, memberId: string, state: "editing" | "left") =>
  JSON.stringify({
    type: "file.presence",
    nodeId,
    memberId,
    state,
  } satisfies StorageFilePresenceEvent);

/** The app sockets that see the drive: everyone's for Shared, the owner's for My files. */
function audience(ctx: DurableObjectState, at: Editing) {
  const sockets = at.ownerMemberId ? ctx.getWebSockets(at.ownerMemberId) : ctx.getWebSockets();
  return sockets.filter((socket) => !ctx.getTags(socket)[0]?.startsWith("sync:"));
}

function sendAll(sockets: WebSocket[], message: string) {
  for (const socket of sockets) {
    try {
      socket.send(message);
    } catch {
      // Closing; the runtime drops it.
    }
  }
}

/** Whether the member still edits the file on a socket other than `except`. */
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
  const { db, close } = openDb(env, 1);
  let found;
  try {
    found = await forMember(db, memberId).storage.file(message.nodeId);
  } finally {
    await close({ timeout: 0 });
  }
  if (latest.get(socket) !== turn || found.status !== "ok" || found.file.trashedAt) return;
  const current = editingOf(socket);
  // A claim the member cannot make is dropped whole: it does not take them off their file.
  if (current && current.nodeId !== message.nodeId) leaveFile(ctx, socket, memberId);
  const at: Editing = {
    nodeId: found.file.id,
    space: found.file.space,
    ownerMemberId: found.file.ownerMemberId,
  };
  socket.serializeAttachment({ ...withoutFile(socket), file: at });
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
