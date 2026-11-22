import type { StorageDocEvent } from "@omni/contracts";
import {
  decodePresence,
  encodePresence,
  presenceSlot,
  stampPresence,
  type PresenceEntry,
} from "@omni/docs/presence";
import { attachmentOf, editingOf, insiders } from "./realtime-files.ts";
import { outsideOf, outsidersOn } from "./realtime-outside.ts";

interface Peer {
  nodeId: string;
  clientId: number;
}

const peerOf = (socket: WebSocket) => (attachmentOf(socket)?.peer as Peer | undefined) ?? null;
const clocks = new WeakMap<WebSocket, number>();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function onDoc(ctx: DurableObjectState, nodeId: string) {
  return [
    ...insiders(ctx).filter((socket) => editingOf(socket)?.nodeId === nodeId),
    ...outsidersOn(ctx, nodeId),
  ];
}

function heldByOther(ctx: DurableObjectState, socket: WebSocket, nodeId: string, id: number) {
  return onDoc(ctx, nodeId).some((other) => {
    if (other === socket) return false;
    const peer = peerOf(other);
    return peer?.nodeId === nodeId && peer.clientId === id;
  });
}

function ownEntries(
  ctx: DurableObjectState,
  socket: WebSocket,
  nodeId: string,
  entries: PresenceEntry[],
) {
  const peer = peerOf(socket);
  const bound = peer?.nodeId === nodeId ? peer.clientId : null;
  const outsider = !!outsideOf(socket);
  const kept: PresenceEntry[] = [];
  for (const entry of entries) {
    if (entry.clientId === bound) {
      kept.push(entry);
      continue;
    }
    if ((bound !== null && outsider) || kept.length > 0) continue;
    if (heldByOther(ctx, socket, nodeId, entry.clientId)) continue;
    socket.serializeAttachment({
      ...attachmentOf(socket),
      peer: { nodeId, clientId: entry.clientId } satisfies Peer,
    });
    kept.push(entry);
  }
  for (const entry of kept) clocks.set(socket, entry.clock);
  return kept;
}

const memberName = (state: Record<string, unknown> | null) => {
  const user = state?.user as { name?: unknown } | undefined;
  return typeof user?.name === "string" && user.name ? user.name.slice(0, 80) : "Member";
};

/**
 * What one socket's `doc.presence` becomes: for the members on the doc and for its outsiders. An
 * outsider's state carries the identity the server gave it, to everyone. A member's reaches
 * members as they sent it and outsiders with their name and colour alone. Null: nothing to pass.
 */
export function relayPresence(
  ctx: DurableObjectState,
  socket: WebSocket,
  input: { nodeId: string; u: string; memberId: string | null },
) {
  const { nodeId } = input;
  const outsiders = outsidersOn(ctx, nodeId).filter((other) => other !== socket);
  const outside = outsideOf(socket);
  const entries = decodePresence(fromBase64(input.u));
  if (!entries) return outside ? null : { members: input.u, outsiders: null };
  const kept = ownEntries(ctx, socket, nodeId, entries);
  if (kept.length === 0) return null;
  if (outside) {
    const stamped = kept.map((entry) => ({
      ...entry,
      state: stampPresence(entry.state, outside.user),
    }));
    const u = toBase64(encodePresence(stamped));
    return { members: u, outsiders: u };
  }
  const members = kept.length === entries.length ? input.u : toBase64(encodePresence(kept));
  if (outsiders.length === 0) return { members, outsiders: null };
  const slot = presenceSlot(input.memberId ?? "member");
  const shown = kept.map((entry) => ({
    ...entry,
    state: stampPresence(entry.state, { name: memberName(entry.state), slot, kind: "member" }),
  }));
  return { members, outsiders: toBase64(encodePresence(shown)) };
}

/** Passes a relayed presence on: to the members editing the doc and to its outsiders. */
export function sendPresence(
  ctx: DurableObjectState,
  socket: WebSocket,
  nodeId: string,
  relayed: { members: string; outsiders: string | null },
) {
  const message = (u: string) =>
    JSON.stringify({ type: "doc.presence", nodeId, u } satisfies StorageDocEvent);
  const forMembers = message(relayed.members);
  for (const other of insiders(ctx)) {
    if (other === socket || editingOf(other)?.nodeId !== nodeId || editingOf(other)?.locked) {
      continue;
    }
    try {
      other.send(forMembers);
    } catch {}
  }
  if (!relayed.outsiders) return;
  const forOutsiders = message(relayed.outsiders);
  for (const other of outsidersOn(ctx, nodeId)) {
    if (other === socket) continue;
    try {
      other.send(forOutsiders);
    } catch {}
  }
}

/**
 * Takes an outsider's cursor off the doc for everyone when its socket goes, as its tab would have
 * on close: a socket dropped without one leaves no stale cursor behind.
 */
export function leavePresence(ctx: DurableObjectState, socket: WebSocket) {
  const peer = peerOf(socket);
  const clock = clocks.get(socket);
  if (!peer || clock === undefined || !outsideOf(socket)) return;
  const u = toBase64(encodePresence([{ clientId: peer.clientId, clock, state: null }]));
  sendPresence(ctx, socket, peer.nodeId, { members: u, outsiders: u });
}

/** An outsider's socket closed: it leaves the doc's presence, and its close is answered. */
export function closeOutsider(ctx: DurableObjectState, socket: WebSocket, code: number) {
  leavePresence(ctx, socket);
  try {
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, "closing");
  } catch {}
}
