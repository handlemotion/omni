import {
  STORAGE_DOC_PRESENCE_MAX,
  storageLiveRecordSchema,
  type StorageDocEvent,
} from "@omni/contracts";

type StorageDocRefusal = Extract<StorageDocEvent, { type: "doc.refused" }>["reason"];
import { z } from "zod";
import { loadConfig } from "./env.ts";
import { createLogger } from "./log.ts";
import {
  audience,
  checkEditing,
  editingOf,
  insiders,
  leaveFile,
  setEditing,
} from "./realtime-files.ts";
import { noteMemberTyped, settleOwed } from "./realtime-folds.ts";
import { sendToOutsiders } from "./realtime-outside.ts";
import { relayPresence, sendPresence } from "./realtime-presence.ts";
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
 * Passes a member's cursor on to the others editing the same file, and keeps nothing. Only from a
 * socket that is editing that file, whose access `doc.append` and `file.presence` keep checked.
 * Members hear it as it was sent; the doc's outsiders, if any, hear the member's name and colour
 * alone (`realtime-presence.ts`).
 */
export function onDocPresence(
  ctx: DurableObjectState,
  socket: WebSocket,
  memberId: string,
  message: DocPresenceMessage,
) {
  const at = editingOf(socket);
  if (at?.nodeId !== message.nodeId || at.locked) return;
  const relayed = relayPresence(ctx, socket, { nodeId: message.nodeId, u: message.u, memberId });
  if (relayed) sendPresence(ctx, socket, message.nodeId, relayed);
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
  const record = { ...message.record, by: `m:${memberId}` };
  let seqNum: number | null;
  try {
    seqNum = await basin.append(docStream(nodeId), JSON.stringify(record), message.matchSeqNum);
  } catch (error) {
    createLogger({ component: "realtime" }).error("doc.append_failed", { error, nodeId });
    return refuse("unavailable");
  }
  if (seqNum === null) return refuse("tail");
  send(socket, { type: "doc.appended", nodeId, ref, seqNum });
  const event = { type: "doc.record", nodeId, seqNum, record } satisfies StorageDocEvent;
  const forMembers = JSON.stringify(event);
  for (const other of audience(ctx, at)) {
    if (other === socket || editingOf(other)?.nodeId !== nodeId) continue;
    try {
      other.send(forMembers);
    } catch {}
  }
  sendToOutsiders(ctx, nodeId, [event]);
  if (record.t === "update") await noteMemberTyped(ctx, { nodeId, memberId, seqNum });
  if (record.t === "fold") {
    await settleOwed(ctx, env, { nodeId, contentVersion: record.cv, s: record.s });
  }
}

/**
 * Passes records the Worker appended itself (a change made through an agent, and its save) to
 * every socket editing the file, the way `onDocAppend` passes on an app's: the members' and the
 * doc's outsiders'.
 */
export function passOnRecords(ctx: DurableObjectState, nodeId: string, events: StorageDocEvent[]) {
  const sockets = insiders(ctx).filter((socket) => {
    const at = editingOf(socket);
    return at?.nodeId === nodeId && !at.locked;
  });
  for (const event of events) {
    for (const socket of sockets) send(socket, event);
  }
  sendToOutsiders(ctx, nodeId, events);
}

/** Tells everyone on the doc, members and outsiders, that its comments changed. */
export function passOnComments(ctx: DurableObjectState, nodeId: string) {
  const event = { type: "doc.comments", nodeId } satisfies StorageDocEvent;
  for (const socket of insiders(ctx)) {
    if (editingOf(socket)?.nodeId === nodeId) send(socket, event);
  }
  sendToOutsiders(ctx, nodeId, [event]);
}
