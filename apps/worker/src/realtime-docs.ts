// Live co-editing (ADR 0043 decision 3 step 2): a socket editing a file (`realtime-files.ts`)
// appends its editor's records to the file's S2 stream, and the others editing it hear each one.
// The access check is the one presence made: a socket says `editing` before it may append.
import { storageLiveRecordSchema, type StorageDocEvent } from "@omni/contracts";

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

/** The stream of a file's live document. */
export const docStream = (nodeId: string) => `docs/${nodeId}`;

/**
 * How old the socket's access check may be when it appends. Access can end while a file is open
 * (moved into someone's My files, trashed, locked), and a typist appends many times a second, so
 * the check is redone at most this often rather than on every record.
 */
const RECHECK_MS = 2000;

/** The largest record message: S2 takes a megabyte a batch, and a document's seed is its whole state. */
export const MAX_DOC_MESSAGE = 900_000;

const send = (socket: WebSocket, event: StorageDocEvent) => {
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // Closing; the runtime drops it.
  }
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
  // Every other socket on the file, the member's own other tabs included.
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
    } catch {
      // Closing.
    }
  }
}
