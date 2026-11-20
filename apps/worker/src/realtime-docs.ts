import {
  STORAGE_DOC_PRESENCE_MAX,
  storageLiveRecordSchema,
  type StorageDocEvent,
} from "@omni/contracts";

type StorageDocRefusal = Extract<StorageDocEvent, { type: "doc.refused" }>["reason"];
import { z } from "zod";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import { audience, checkEditing, editingOf, leaveFile, setEditing } from "./realtime-files.ts";
import { s2Basin } from "./s2.ts";

/** What an app sends: one record for the file's stream (`@omni/contracts`, `storageDocEventSchema`). */
export const docAppendMessage = z.object({
  type: z.literal("doc.append"),
  nodeId: z.string().min(1).max(64),
  ref: z.number().int(),
  record: storageLiveRecordSchema,
  matchSeqNum: z.number().int().nonnegative().optional(),
});
export type DocAppendMessage = z.infer<typeof docAppendMessage>;

/** Where someone's cursor is in the file they edit (`@omni/contracts`, `storageDocEventSchema`). */
export const docPresenceMessage = z.object({
  type: z.literal("doc.presence"),
  nodeId: z.string().min(1).max(64),
  u: z.base64().max(STORAGE_DOC_PRESENCE_MAX),
});
export type DocPresenceMessage = z.infer<typeof docPresenceMessage>;

/** The longest `doc.presence` message, envelope and all. */
export const MAX_PRESENCE_MESSAGE = STORAGE_DOC_PRESENCE_MAX + 256;

/**
 * Passes a cursor on to the others editing the same file, as it is, and keeps nothing. Only from a
 * socket that is editing that file, whose access `doc.append` and `file.presence` keep checked.
 */
export function onDocPresence(
  ctx: DurableObjectState,
  socket: WebSocket,
  message: DocPresenceMessage,
) {
  const at = editingOf(socket);
  if (at?.nodeId !== message.nodeId || at.locked) return;
  const event = JSON.stringify({
    type: "doc.presence",
    nodeId: message.nodeId,
    u: message.u,
  } satisfies StorageDocEvent);
  for (const other of audience(ctx, at)) {
    if (other === socket || editingOf(other)?.nodeId !== message.nodeId) continue;
    try {
      other.send(event);
    } catch {}
  }
}

/** The stream of a file's live document. */
export const docStream = (nodeId: string) => `docs/${nodeId}`;

const RECHECK_MS = 2000;

/** The largest record message: S2 takes a megabyte a batch, and a document's seed is its whole state. */
export const MAX_DOC_MESSAGE = 900_000;

const send = (socket: WebSocket, event: StorageDocEvent) => {
  try {
    socket.send(JSON.stringify(event));
  } catch {}
};

export async function onDocAppend(
  ctx: DurableObjectState,
  env: Env,
  socket: WebSocket,
  memberId: string,
  message: DocAppendMessage,
) {
  const { nodeId, ref } = message;
  let at = editingOf(socket);
  const basin = s2Basin(loadConfig(env));
  const refuse = (reason: StorageDocRefusal) =>
    send(socket, { type: "doc.refused", nodeId, ref, reason });
  if (!basin) return refuse("unavailable");
  if (at?.nodeId !== nodeId) return refuse("editing");
  if (Date.now() - (at.checkedAt ?? 0) > RECHECK_MS) {
    const now = await checkEditing(env, memberId, nodeId);
    if (editingOf(socket)?.nodeId !== nodeId) return refuse("editing");
    if (!now) {
      leaveFile(ctx, socket, memberId);
      return refuse("denied");
    }
    setEditing(socket, now);
    at = now;
  }
  if (at.locked) return refuse("locked");
  let seqNum: number | null;
  try {
    seqNum = await basin.append(
      docStream(nodeId),
      JSON.stringify(message.record),
      message.matchSeqNum,
    );
  } catch (error) {
    createLogger({ component: "realtime" }).error("doc.append_failed", { error, nodeId });
    return refuse("unavailable");
  }
  if (seqNum === null) return refuse("tail");
  send(socket, { type: "doc.appended", nodeId, ref, seqNum });
  const record = JSON.stringify({
    type: "doc.record",
    nodeId,
    seqNum,
    record: message.record,
  } satisfies StorageDocEvent);
  for (const other of audience(ctx, at)) {
    if (other === socket || editingOf(other)?.nodeId !== nodeId) continue;
    try {
      other.send(record);
    } catch {}
  }
}

/**
 * Passes records the Worker appended itself (a change made through an agent, and its save) to
 * every socket editing the file, the way `onDocAppend` passes on an app's.
 */
export function passOnRecords(ctx: DurableObjectState, nodeId: string, events: StorageDocEvent[]) {
  const sockets = ctx.getWebSockets().filter((socket) => {
    const at = editingOf(socket);
    return at?.nodeId === nodeId && !at.locked;
  });
  for (const event of events) {
    for (const socket of sockets) send(socket, event);
  }
}
