import {
  storageLiveRecordSchema,
  type StorageDocEvent,
  type StorageLiveEntry,
  type StorageLiveRecord,
} from "@omni/contracts";
import { liveMarkdown, rewriteLive } from "@omni/docs";
import * as Y from "yjs";
import { docStream } from "../realtime-docs.ts";
import type { S2Basin } from "../s2.ts";

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function readFrom(basin: S2Basin, nodeId: string, from: number) {
  const entries: StorageLiveEntry[] = [];
  for (let at = from; ;) {
    const page = await basin.read(docStream(nodeId), at);
    for (const { seqNum, body } of page.records) {
      let parsed;
      try {
        parsed = storageLiveRecordSchema.safeParse(JSON.parse(body));
      } catch {
        continue;
      }
      if (parsed.success) entries.push({ seqNum, record: parsed.data });
    }
    const last = page.records.at(-1);
    if (!page.more || !last) return entries;
    at = last.seqNum + 1;
  }
}

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

  private constructor(basin: S2Basin, nodeId: string, epoch: number) {
    this.basin = basin;
    this.nodeId = nodeId;
    this.epoch = epoch;
    this.next = epoch;
  }

  /** The live document of `nodeId` at `contentVersion`; null when nobody is editing it live. */
  static async open(basin: S2Basin, nodeId: string, contentVersion: number) {
    const entries = await readFrom(basin, nodeId, 0);
    const start = entries.findLastIndex((entry) => entry.record.t === "seed");
    const seed = entries[start];
    if (!seed || seed.record.t !== "seed") return null;
    let cv = seed.record.cv;
    for (const entry of entries.slice(start + 1)) {
      if (entry.record.t === "fold" && entry.record.e === seed.seqNum) cv = entry.record.cv;
    }
    if (cv !== contentVersion) return null;
    const live = new LiveFile(basin, nodeId, seed.seqNum);
    live.take(entries.slice(start));
    return live;
  }

  /** The Markdown it holds now. */
  get markdown() {
    return liveMarkdown(this.doc);
  }

  /**
   * Makes it hold `markdown`: appends the difference as a change everyone editing merges with
   * their own, then catches up with what others appended meanwhile. Answers the records to pass
   * on and the last one the document now holds.
   */
  async rewrite(markdown: string) {
    const update = rewriteLive(this.doc, markdown);
    const record: StorageLiveRecord = { t: "update", e: this.epoch, u: toBase64(update) };
    const seqNum = await this.basin.append(docStream(this.nodeId), JSON.stringify(record));
    if (seqNum === null) throw new Error("storage: the live document refused a change");
    this.take(await readFrom(this.basin, this.nodeId, this.next));
    return { entry: { seqNum, record } satisfies StorageLiveEntry, through: this.next - 1 };
  }

  /** Records that the document through record `through` was saved as `contentVersion`. */
  async folded(contentVersion: number, through: number) {
    const record: StorageLiveRecord = { t: "fold", e: this.epoch, cv: contentVersion, s: through };
    const seqNum = await this.basin.append(docStream(this.nodeId), JSON.stringify(record));
    if (seqNum === null) throw new Error("storage: the live document refused a save");
    return { seqNum, record } satisfies StorageLiveEntry;
  }

  /** The latest save recorded in the epoch since this opened, and the record it holds through. */
  async lastFold() {
    const entries = await readFrom(this.basin, this.nodeId, this.epoch);
    let found: { cv: number; s: number } | null = null;
    for (const { record } of entries) {
      if (record.t === "fold" && record.e === this.epoch) found = { cv: record.cv, s: record.s };
    }
    return found;
  }

  private take(entries: StorageLiveEntry[]) {
    for (const { seqNum, record } of entries) {
      if (seqNum < this.next) continue;
      if (
        record.t !== "fold" &&
        (record.t === "seed" ? seqNum === this.epoch : record.e === this.epoch)
      ) {
        Y.applyUpdate(this.doc, fromBase64(record.u));
      }
      this.next = seqNum + 1;
    }
  }
}

/** The events that pass `entries` on to everyone editing the file. */
export const docRecordEvents = (nodeId: string, entries: StorageLiveEntry[]) =>
  entries.map(
    ({ seqNum, record }) =>
      ({ type: "doc.record", nodeId, seqNum, record }) satisfies StorageDocEvent,
  );
