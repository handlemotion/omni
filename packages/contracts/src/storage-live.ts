import { z } from "zod";

const id = z.string().min(1);

/**
 * Live co-editing: an open document is one S2 stream of these
 * records, `docs/<nodeId>`. A `seed` starts an epoch: the editor's whole state, made from the file
 * at `contentVersion`. Each `update` (an editor update, base64) and `fold` names its epoch by the
 * seed's sequence number; a `fold` says the epoch up to record `s` was saved as `contentVersion`. An editor joins
 * the latest epoch when the file's content version is that epoch's last one, and seeds a new one
 * otherwise (the file changed outside the live layer).
 *
 * A `snap` is a checkpoint of epoch `e`: its whole state through record `s` (with every record
 * before it), and the epoch's latest save then, `contentVersion` `cv` holding the records through
 * `f`. A reader starts at the latest `seed` or `snap` instead of the stream's first record, so a
 * document opens in a few records however long it has been edited. Editors write one every
 * `STORAGE_LIVE_SNAP_EVERY` records; a reader that does not know `snap` may apply its `u` as an
 * update of the epoch, which it is.
 */
export const storageLiveRecordSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("seed"), cv: z.number().int().nonnegative(), u: z.base64() }),
  z.object({
    t: z.literal("update"),
    e: z.number().int().nonnegative(),
    u: z.base64(),
    /**
     * Who sent it, set by the realtime object whatever the sender wrote: `m:<memberId>`,
     * `u:<userId>` for a person with a grant, `g:<guestId>` for a guest through a link. Absent
     * from records written before this, by the Worker itself, and in what an outsider is sent.
     */
    by: z.string().max(80).optional(),
  }),
  z.object({
    t: z.literal("fold"),
    e: z.number().int().nonnegative(),
    cv: z.number().int().nonnegative(),
    /** The last record the saved text held, with every one before it. */
    s: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("snap"),
    e: z.number().int().nonnegative(),
    /** The last record the state holds, with every one before it. */
    s: z.number().int().nonnegative(),
    cv: z.number().int().nonnegative(),
    /** The last record the save `cv` held: the epoch's seed when nothing was saved since. */
    f: z.number().int().nonnegative(),
    u: z.base64(),
  }),
]);

/** How many records an editor lets pass after the latest `seed` or `snap` before it writes one. */
export const STORAGE_LIVE_SNAP_EVERY = 200;

/** The epoch's first record a reader needs, for a `seed` or `snap` at `seqNum`. */
export const liveStartOf = (entry: { seqNum: number; record: StorageLiveRecord }) =>
  entry.record.t === "snap" ? entry.record.s + 1 : entry.seqNum;

type EpochStart = Extract<StorageLiveRecord, { t: "seed" | "snap" }>;

/**
 * Where the latest epoch among `entries` starts: its seed, or its latest snap. The latest epoch is
 * the newest any record names, so a snap of an older epoch that landed after a newer seed (a tab
 * slow to send it) is skipped. Undefined when no start of that epoch is among them.
 */
export function latestEpochStart(entries: { seqNum: number; record: StorageLiveRecord }[]) {
  let epoch = -1;
  for (const { seqNum, record } of entries) {
    epoch = Math.max(epoch, record.t === "seed" ? seqNum : record.e);
  }
  let start: { seqNum: number; record: EpochStart } | undefined;
  for (const { seqNum, record } of entries) {
    const starts =
      record.t === "seed" ? seqNum === epoch : record.t === "snap" && record.e === epoch;
    if (starts && (record.t === "seed" || record.t === "snap")) start = { seqNum, record };
  }
  return start;
}

/** One record of the stream, at its sequence number. */
export const storageLiveEntrySchema = z.object({
  seqNum: z.number().int().nonnegative(),
  record: storageLiveRecordSchema,
});

/**
 * `GET /files/:id/live?from=`: the document's records from `from` (0 by default), at most 1000;
 * `more` when there may be others after them. `enabled: false` when the live layer is off: the
 * document edits with checked saves alone. `?from=latest` starts at what a reader of the latest
 * epoch needs: from its latest `seed`, or from a `snap` and the records after the ones it holds.
 */
export const storageLiveReadQuerySchema = z.object({
  from: z.union([z.literal("latest"), z.coerce.number().int().nonnegative()]).optional(),
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
 * again after it), `denied` (the member no longer reaches the file), `locked`, `unavailable`
 * (the live layer is off or failed), `read_only` (an outsider whose role does not edit, or a
 * record an outsider may not write: only `update`s) or `rate` (an outsider over their limits).
 * The others editing the file hear `doc.record`. Records can arrive out of order and a dropped
 * socket misses some: read the gap with `GET /files/:id/live` (an outsider:
 * `GET /shared/:shareId/files/:id/live`).
 *
 * `{"type":"doc.presence","nodeId","u"}` is where someone's cursor is, and who they are: a Yjs
 * awareness update, base64. The Worker passes it on to the others editing the file and keeps
 * nothing; an app that hears someone new answers with its own. While someone outside the
 * workspace is on the doc, the Worker rewrites each state's `user` as `{ name, slot, kind }`
 * (`kind` member, grantee or guest; `slot` 1-6 picks their colour) and keeps only `user`, `cursor`
 * and `comments`: nobody names themselves, and outsiders hear no member's picture or address.
 *
 * `doc.access` tells an outsider's socket its role changed (`null`: it no longer reaches the
 * file, and the socket closes with `4403`). `doc.comments` tells everyone on the doc that its
 * comments changed: fetch them again.
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
    reason: z.enum(["tail", "editing", "denied", "locked", "unavailable", "read_only", "rate"]),
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
  z.object({
    type: z.literal("doc.access"),
    nodeId: id,
    role: z.enum(["editor", "commenter"]).nullable(),
  }),
  z.object({ type: z.literal("doc.comments"), nodeId: id }),
]);

export type StorageLiveRecord = z.infer<typeof storageLiveRecordSchema>;
export type StorageLiveEntry = z.infer<typeof storageLiveEntrySchema>;
export type StorageLiveReadResponse = z.infer<typeof storageLiveReadResponseSchema>;
export type StorageDocEvent = z.infer<typeof storageDocEventSchema>;
