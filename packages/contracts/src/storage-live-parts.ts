import type { StorageLiveEntry, StorageLiveRecord } from "./storage-live.ts";

/** The most parts one record is split into: 16 MB of state at `STORAGE_LIVE_PART_CHARS`. */
export const STORAGE_LIVE_MAX_PARTS = 20;

/**
 * The base64 characters in each part an app splits a record into, to fit one socket message:
 * 600 kB of bytes, a multiple of 4 characters (3 bytes), so the parts' text joined is the whole
 * record's base64.
 */
export const STORAGE_LIVE_PART_CHARS = 800_000;

/**
 * The most base64 characters one S2 record carries (its limit is 1 MiB). The Worker splits only
 * records past it, so every record that fit one before parts existed still goes as one.
 */
export const STORAGE_LIVE_RECORD_CHARS = 1_000_000;

/**
 * How many records may pass after a split record's head before a reader gives up on its missing
 * parts: its writer sends the whole change again under a new head, so the old one is abandoned.
 */
export const STORAGE_LIVE_PART_WINDOW = 1000;

type Splittable = Extract<StorageLiveRecord, { t: "seed" | "snap" | "update" }>;

/**
 * `record` as the records to append: itself when it fits one, else its head (with `n` and the
 * first part) and, given the head's sequence number, the `more` records that follow it.
 */
export function splitLiveRecord(record: Splittable, partChars = STORAGE_LIVE_PART_CHARS) {
  if (partChars % 4) throw new Error("storage: parts must split base64 on whole bytes");
  if (record.u.length <= partChars) return { head: record, rest: () => [] };
  const chunks: string[] = [];
  for (let at = 0; at < record.u.length; at += partChars) {
    chunks.push(record.u.slice(at, at + partChars));
  }
  if (chunks.length > STORAGE_LIVE_MAX_PARTS)
    throw new Error("storage: a live record is too large");
  const head = { ...record, u: chunks[0]!, n: chunks.length } satisfies StorageLiveRecord;
  const rest = (h: number) =>
    chunks.slice(1).map((u, k) => ({ t: "more", h, i: k + 1, u }) satisfies StorageLiveRecord);
  return { head, rest };
}

/** A record whole again: where it starts, its last part in the stream, and every record it took. */
export type LiveWhole = StorageLiveEntry & { completedAt: number; seqNums: number[] };

/**
 * Joins split records as their parts arrive, in any order: `push` answers each record that is
 * whole now (one that was never split, or a split one whose last part just came, joined and
 * without `n`), and null for a part or a record still waiting for parts.
 */
export class LiveParts {
  private readonly heads = new Map<number, StorageLiveEntry>();
  private readonly pieces = new Map<number, Map<number, { u: string; seqNum: number }>>();

  push(entry: StorageLiveEntry) {
    const { seqNum, record } = entry;
    if (record.t === "more") {
      const got = this.pieces.get(record.h) ?? new Map<number, { u: string; seqNum: number }>();
      got.set(record.i, { u: record.u, seqNum });
      this.pieces.set(record.h, got);
      return this.complete(record.h);
    }
    if (!("n" in record) || record.n === undefined) {
      return { ...entry, completedAt: seqNum, seqNums: [seqNum] } satisfies LiveWhole;
    }
    this.heads.set(seqNum, entry);
    return this.complete(seqNum);
  }

  /**
   * The first change still waiting for parts, or null: no save may claim to hold it. A split
   * `seed` or `snap` holds back nothing, as it repeats state the document already has.
   */
  pendingFrom() {
    const waiting = [...this.heads].filter(([, e]) => e.record.t === "update").map(([h]) => h);
    return waiting.length ? Math.min(...waiting) : null;
  }

  /** Forgets the split record at `h`: answers every record of it it holds. */
  drop(h: number) {
    const gone = this.heads.delete(h) ? [h] : [];
    for (const part of this.pieces.get(h)?.values() ?? []) gone.push(part.seqNum);
    this.pieces.delete(h);
    return gone;
  }

  /**
   * Gives up on split records whose head is more than `STORAGE_LIVE_PART_WINDOW` records before
   * `at`: answers every record of theirs it holds (to count as read), and forgets them.
   */
  abandon(at: number) {
    const gone: number[] = [];
    for (const h of new Set([...this.heads.keys(), ...this.pieces.keys()])) {
      if (h >= at - STORAGE_LIVE_PART_WINDOW) continue;
      if (this.heads.delete(h)) gone.push(h);
      for (const part of this.pieces.get(h)?.values() ?? []) gone.push(part.seqNum);
      this.pieces.delete(h);
    }
    return gone;
  }

  private complete(h: number) {
    const head = this.heads.get(h);
    const got = this.pieces.get(h);
    if (!head || head.record.t === "more" || head.record.t === "fold") return null;
    const n = head.record.n ?? 1;
    let u = head.record.u;
    const seqNums = [h];
    for (let i = 1; i < n; i++) {
      const part = got?.get(i);
      if (part === undefined) return null;
      u += part.u;
      seqNums.push(part.seqNum);
    }
    this.heads.delete(h);
    this.pieces.delete(h);
    const { n: _n, ...whole } = head.record;
    const record = { ...whole, u } as StorageLiveRecord;
    return { seqNum: h, record, completedAt: Math.max(...seqNums), seqNums } satisfies LiveWhole;
  }
}

/** Whether the split record at `seqNum` has all its parts among `entries`. */
export function liveRecordWhole(entries: StorageLiveEntry[], seqNum: number) {
  const head = entries.find((entry) => entry.seqNum === seqNum);
  if (!head || !("n" in head.record) || head.record.n === undefined) return !!head;
  const have = new Set(
    entries.flatMap(({ record }) => (record.t === "more" && record.h === seqNum ? [record.i] : [])),
  );
  return have.size >= head.record.n - 1;
}
