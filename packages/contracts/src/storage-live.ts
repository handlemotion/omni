import { z } from "zod";

const id = z.string().min(1);

/**
 * Live co-editing: an open document is one S2 stream of these
 * records, `docs/<nodeId>`. A `seed` starts an epoch: the editor's whole state, made from the file
 * at `contentVersion`. Each `update` (an editor update, base64) and `fold` names its epoch by the
 * seed's sequence number; a `fold` says the epoch up to record `s` was saved as `contentVersion`. An editor joins
 * the latest epoch when the file's content version is that epoch's last one, and seeds a new one
 * otherwise (the file changed outside the live layer).
 */
export const storageLiveRecordSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("seed"), cv: z.number().int().nonnegative(), u: z.base64() }),
  z.object({ t: z.literal("update"), e: z.number().int().nonnegative(), u: z.base64() }),
  z.object({
    t: z.literal("fold"),
    e: z.number().int().nonnegative(),
    cv: z.number().int().nonnegative(),
    /** The last record the saved text held, with every one before it. */
    s: z.number().int().nonnegative(),
  }),
]);

/** One record of the stream, at its sequence number. */
export const storageLiveEntrySchema = z.object({
  seqNum: z.number().int().nonnegative(),
  record: storageLiveRecordSchema,
});

/**
 * `GET /files/:id/live?from=`: the document's records from `from` (0 by default), at most 1000;
 * `more` when there may be others after them. `enabled: false` when the live layer is off: the
 * document edits with checked saves alone.
 */
export const storageLiveReadQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
});
export const storageLiveReadResponseSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    entries: z.array(storageLiveEntrySchema),
    more: z.boolean(),
  }),
]);

/**
 * The longest `doc.presence` update, base64: one person's cursor and name, with room to spare.
 */
export const STORAGE_DOC_PRESENCE_MAX = 4096;

/**
 * On the realtime socket, while the socket edits the file (after its `file.presence` `editing`):
 * the app sends `{"type":"doc.append","nodeId","ref","record","matchSeqNum"?}`; `ref` is the app's
 * own number for it. The sender hears `doc.appended` with its sequence number, or `doc.refused`
 * with why: `tail` (a `matchSeqNum` that was no longer the tail: read the stream again),
 * `editing` (the socket's `editing` has not been checked yet, or it is not editing the file: try
 * again after it), `denied` (the member no longer reaches the file), `locked`, or `unavailable` (the live layer is off or failed). The others
 * editing the file hear `doc.record`. Records can arrive out of
 * order and a dropped socket misses some: read the gap with `GET /files/:id/live`.
 *
 * `{"type":"doc.presence","nodeId","u"}` is where someone's cursor is, and who they are: a Yjs
 * awareness update, base64. The Worker passes it on, as it is, to the others editing the file
 * and keeps nothing; an app that hears someone new answers with its own.
 */
export const storageDocEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("doc.appended"),
    nodeId: id,
    ref: z.number().int(),
    seqNum: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("doc.refused"),
    nodeId: id,
    ref: z.number().int(),
    reason: z.enum(["tail", "editing", "denied", "locked", "unavailable"]),
  }),
  z.object({
    type: z.literal("doc.record"),
    nodeId: id,
    seqNum: z.number().int().nonnegative(),
    record: storageLiveRecordSchema,
  }),
  z.object({
    type: z.literal("doc.presence"),
    nodeId: id,
    u: z.base64().max(STORAGE_DOC_PRESENCE_MAX),
  }),
]);

export type StorageLiveRecord = z.infer<typeof storageLiveRecordSchema>;
export type StorageLiveEntry = z.infer<typeof storageLiveEntrySchema>;
export type StorageLiveReadResponse = z.infer<typeof storageLiveReadResponseSchema>;
export type StorageDocEvent = z.infer<typeof storageDocEventSchema>;
