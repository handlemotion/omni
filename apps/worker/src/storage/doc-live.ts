import {
  latestEpochStart,
  STORAGE_LIVE_SNAP_EVERY,
  type StorageDocEvent,
  type StorageLiveEntry,
  type StorageLiveRecord,
} from "@omni/contracts";
import { liveMarkdown, rewriteLive } from "@omni/docs";
import * as Y from "yjs";
import { docStream } from "../realtime-docs.ts";
import type { S2Basin } from "../s2.ts";
import { latestLiveStart, readLive } from "./live-read.ts";

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const SNAP_MAX_CHARS = 850_000;
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * A file's open live document, when its latest epoch holds the file's content now (the same rule
 * an editor joins by): the document with every change made in it, saved or not.
 */
export class LiveFile {
  readonly doc = new Y.Doc();
  private next: number;
  private readonly basin: S2Basin;
  private readonly nodeId: string;
  readonly epoch: number;

  private fold: { cv: number; s: number };
  private changedAt = -1;
  private start = -1;

  private constructor(
    basin: S2Basin,
    nodeId: string,
    epoch: number,
    fold: { cv: number; s: number },
  ) {
    this.basin = basin;
    this.nodeId = nodeId;
    this.epoch = epoch;
    this.next = epoch;
    this.fold = fold;
  }

  /** The live document of `nodeId` at `contentVersion`; null when nobody is editing it live. */
  static async open(basin: S2Basin, nodeId: string, contentVersion: number) {
    const live = await LiveFile.latest(basin, nodeId);
    return live?.fold.cv === contentVersion ? live : null;
  }

  /** The latest epoch of `nodeId`, whatever version of the file it last saved. */
  static async latest(basin: S2Basin, nodeId: string) {
    const entries = await readLive(basin, nodeId, await latestLiveStart(basin, nodeId));
    const first = latestEpochStart(entries);
    if (!first) return null;
    const { record } = first;
    const epoch = record.t === "snap" ? record.e : first.seqNum;
    const live = new LiveFile(basin, nodeId, epoch, {
      cv: record.cv,
      s: record.t === "snap" ? record.f : epoch,
    });
    live.start = first.seqNum;
    if (record.t === "snap") {
      Y.applyUpdate(live.doc, fromBase64(record.u));
      live.next = record.s + 1;
      live.changedAt = record.s;
    }
    live.take(entries);
    return live;
  }

  /** The version of the file its latest recorded save made. */
  get savedAs() {
    return this.fold.cv;
  }

  /** The Markdown it holds now. */
  get markdown() {
    return liveMarkdown(this.doc);
  }

  /** The last record it holds, with every one before it. */
  get through() {
    return this.next - 1;
  }

  /** Whether it holds changes made after its latest save: typing the file does not have yet. */
  get unsaved() {
    return this.changedAt > this.fold.s;
  }

  /**
   * Makes it hold `markdown`: appends the difference as a change everyone editing merges with
   * their own, then catches up with what others appended meanwhile. Answers the records to pass
   * on and the last one the document now holds.
   */
  rewrite(markdown: string, by?: string) {
    return this.append(rewriteLive(this.doc, markdown), by);
  }

  /**
   * Appends `update`, a change already made to this document, for everyone editing to merge with
   * their own, then catches up with what others appended meanwhile. Answers the record to pass on
   * and the last one the document now holds.
   */
  async append(update: Uint8Array, by?: string) {
    const record: StorageLiveRecord = {
      t: "update",
      e: this.epoch,
      u: toBase64(update),
      ...(by ? { by } : {}),
    };
    const seqNum = await this.basin.append(docStream(this.nodeId), JSON.stringify(record));
    if (seqNum === null) throw new Error("storage: the live document refused a change");
    this.take(await readLive(this.basin, this.nodeId, this.next));
    return { entry: { seqNum, record } satisfies StorageLiveEntry, through: this.next - 1 };
  }

  /** Records that the document through record `through` was saved as `contentVersion`. */
  async folded(contentVersion: number, through: number) {
    const record: StorageLiveRecord = { t: "fold", e: this.epoch, cv: contentVersion, s: through };
    const seqNum = await this.basin.append(docStream(this.nodeId), JSON.stringify(record));
    if (seqNum === null) throw new Error("storage: the live document refused a save");
    if (contentVersion > this.fold.cv) this.fold = { cv: contentVersion, s: through };
    return { seqNum, record } satisfies StorageLiveEntry;
  }

  /**
   * After a save through `through` as `contentVersion`, writes a snap when the epoch has gone
   * `STORAGE_LIVE_SNAP_EVERY` records past its latest start: on a doc only outsiders type in, no
   * tab writes one. Null when none is due, or the state is too large for one record.
   */
  async snapIfDue(contentVersion: number, through: number) {
    if (this.start < 0 || through - this.start < STORAGE_LIVE_SNAP_EVERY) return null;
    const u = toBase64(Y.encodeStateAsUpdate(this.doc));
    if (u.length > SNAP_MAX_CHARS) return null;
    const record: StorageLiveRecord = {
      t: "snap",
      e: this.epoch,
      s: through,
      cv: contentVersion,
      f: through,
      u,
    };
    const seqNum = await this.basin.append(docStream(this.nodeId), JSON.stringify(record));
    if (seqNum === null) return null;
    this.start = seqNum;
    return { seqNum, record } satisfies StorageLiveEntry;
  }

  /** The latest save recorded in the epoch, and the record it holds through. */
  async lastFold() {
    this.take(await readLive(this.basin, this.nodeId, this.next));
    return this.fold;
  }

  private take(entries: StorageLiveEntry[]) {
    for (const { seqNum, record } of entries) {
      if (seqNum < this.next) continue;
      this.next = seqNum + 1;
      if (record.t === "seed" ? seqNum !== this.epoch : record.e !== this.epoch) continue;
      if (record.t === "fold") {
        if (record.cv > this.fold.cv) this.fold = { cv: record.cv, s: record.s };
        continue;
      }
      Y.applyUpdate(this.doc, fromBase64(record.u));
      if (record.t === "update") this.changedAt = seqNum;
    }
  }
}

/** The events that pass `entries` on to everyone editing the file. */
export const docRecordEvents = (nodeId: string, entries: StorageLiveEntry[]) =>
  entries.map(
    ({ seqNum, record }) =>
      ({ type: "doc.record", nodeId, seqNum, record }) satisfies StorageDocEvent,
  );
