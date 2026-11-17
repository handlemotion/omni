import type { RealtimeClientMessage, RealtimeEvent } from "@omni/client";
import * as Y from "yjs";
import { api, call } from "./api.ts";
import { onDocEvent, onRealtimeOpen, sendRealtime } from "./realtime.ts";

type StorageDocEvent = Extract<
  RealtimeEvent,
  { type: "doc.record" | "doc.appended" | "doc.refused" }
>;
type StorageLiveRecord = Extract<RealtimeClientMessage, { type: "doc.append" }>["record"];
interface StorageLiveEntry {
  seqNum: number;
  record: StorageLiveRecord;
}

const REMOTE = Symbol("remote");
let nextRef = 1;
const BATCH_MS = 60;
const RETRY_MS = 400;
const UNAVAILABLE_MS = 1000;
const UNAVAILABLE_MAX_MS = 15_000;
const SETTLE_MS = 5000;

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const readAll: (nodeId: string, from?: number) => Promise<StorageLiveEntry[] | null> = async (
  nodeId,
  from = 0,
) => {
  const entries: StorageLiveEntry[] = [];
  for (let at = from; ;) {
    const page = await call(
      api.storage.files[":id"].live.$get({ param: { id: nodeId }, query: { from: String(at) } }),
    );
    if (!page.enabled) return null;
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (!page.more || !last) return entries;
    at = last.seqNum + 1;
  }
};

export interface LiveDocOptions {
  orgId: string;
  nodeId: string;
  /** The content version of the file as the editor read it. */
  contentVersion: number;
  /** Fills an empty document from the file's Markdown: the start of a new epoch. */
  seed: (doc: Y.Doc) => void;
  /**
   * Someone started a new epoch from the file at `contentVersion` (it changed outside the live
   * layer): reopen the editor on it.
   */
  onReplaced: (contentVersion: number) => void;
  /** The epoch was saved as `contentVersion`, by this tab or another. */
  onFolded: (contentVersion: number) => void;
  /** The stream took a change this tab made: whether to save is worth asking again. */
  onAcked: () => void;
}

/**
 * Joins the file's live document: its latest epoch when that epoch is the file's content now,
 * else a new epoch seeded from it. Null when the live layer is off.
 */
export async function openLiveDoc(options: LiveDocOptions) {
  for (let tries = 0; tries < 5; tries++) {
    const entries = await readAll(options.nodeId);
    if (!entries) return null satisfies LiveDoc | null;
    const live = new LiveDoc(options);
    const joined = live.join(entries);
    if (joined === true) return live.start() satisfies LiveDoc | null;
    if (joined !== false) {
      live.close();
      options.onReplaced(joined);
      return null satisfies LiveDoc | null;
    }
    const tail = (entries.at(-1)?.seqNum ?? -1) + 1;
    if (await live.seed(tail)) return live.start() satisfies LiveDoc | null;
    live.close();
  }
  throw new Error("the live document kept changing while it opened");
}

export class LiveDoc {
  readonly doc = new Y.Doc();
  private epoch = -1;
  private known = new Set<number>();
  private next = 0;
  private last = { seqNum: -1, mine: false };
  private lastFold = -1;
  private pending = new Map<number, { record: StorageLiveRecord; matchSeqNum?: number }>();
  private answers = new Map<number, (event: StorageDocEvent) => void>();
  private batch: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private catchingUp = false;
  private stops: (() => void)[] = [];
  private closed = false;
  private started = false;

  private readonly options: LiveDocOptions;

  constructor(options: LiveDocOptions) {
    this.options = options;
    this.stops.push(
      onDocEvent((event) => {
        if (event.nodeId !== this.options.nodeId) return;
        if (event.type !== "doc.record") return this.answers.get(event.ref)?.(event);
        if (this.started) this.onRecord(event.seqNum, event.record);
      }),
      onRealtimeOpen((orgId) => {
        if (orgId !== this.options.orgId) return;
        for (const [ref, item] of this.pending) this.transmit(ref, item);
        if (this.started) void this.catchUp();
      }),
    );
  }

  /**
   * Joins the latest epoch from the stream's records: true when joined, false when there is none
   * to join (none yet, or the file changed outside the live layer), or the content version the
   * epoch was saved as when that is newer than the file this tab read.
   */
  join(entries: StorageLiveEntry[]) {
    const start = entries.findLastIndex((entry) => entry.record.t === "seed");
    const seed = entries[start];
    if (!seed || seed.record.t !== "seed") return false;
    let cv = seed.record.cv;
    for (const entry of entries.slice(start + 1)) {
      if (entry.record.t === "fold" && entry.record.e === seed.seqNum) cv = entry.record.cv;
    }
    if (cv > this.options.contentVersion) return cv;
    if (cv !== this.options.contentVersion) return false;
    this.epoch = seed.seqNum;
    this.next = seed.seqNum;
    for (const entry of entries.slice(start)) this.apply(entry, false);
    return true;
  }

  /** Starts a new epoch from the file, if `tail` is still the stream's end. */
  async seed(tail: number) {
    this.options.seed(this.doc);
    const record: StorageLiveRecord = {
      t: "seed",
      cv: this.options.contentVersion,
      u: toBase64(Y.encodeStateAsUpdate(this.doc)),
    };
    const answer = await this.send(record, tail);
    if (answer.type !== "doc.appended") return false;
    this.epoch = answer.seqNum;
    this.next = answer.seqNum;
    this.markKnown(answer.seqNum, true);
    this.last = { seqNum: answer.seqNum, mine: false };
    return true;
  }

  /** Takes changes made in this tab, and records from others, once the document is joined. */
  start() {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || this.closed) return;
      this.batch.push(update);
      this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
    });
    this.started = true;
    void this.catchUp();
    return this;
  }

  /** Whether this tab wrote the epoch's last change and it has not been saved since. */
  get needsFold() {
    return this.last.mine && this.last.seqNum > this.lastFold && this.pending.size === 0;
  }

  /**
   * The last record the document holds all of, and all before it: a save of its text now holds
   * them, and no more (a change after it, of anyone's, is saved by its own fold).
   */
  get boundary() {
    return this.next - 1;
  }

  /** Records that the epoch up to `boundary` was saved as `contentVersion`. */
  async folded(contentVersion: number, boundary: number) {
    const answer = await this.send({ t: "fold", e: this.epoch, cv: contentVersion, s: boundary });
    if (answer.type === "doc.appended") this.lastFold = Math.max(this.lastFold, boundary);
  }

  /** Sends this tab's changes now and waits (a while) for the stream to take them all. */
  async settle() {
    clearTimeout(this.timer);
    this.flush();
    const until = Date.now() + SETTLE_MS;
    while (this.pendingUpdates() && Date.now() < until && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private pendingUpdates() {
    return [...this.pending.values()].some((item) => item.record.t === "update");
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const stop of this.stops) stop();
    for (const resolve of this.answers.values()) {
      resolve({ type: "doc.refused", nodeId: this.options.nodeId, ref: 0, reason: "unavailable" });
    }
    this.doc.destroy();
  }

  private flush() {
    this.timer = undefined;
    if (this.batch.length === 0 || this.closed) return;
    const update = Y.mergeUpdates(this.batch);
    this.batch = [];
    void this.send({ t: "update", e: this.epoch, u: toBase64(update) }).then((answer) => {
      if (answer.type !== "doc.appended") return;
      this.last = { seqNum: answer.seqNum, mine: true };
      this.options.onAcked();
    });
  }

  private send(record: StorageLiveRecord, matchSeqNum?: number) {
    const ref = nextRef++;
    const item = { record, ...(matchSeqNum === undefined ? {} : { matchSeqNum }) };
    this.pending.set(ref, item);
    let wait = UNAVAILABLE_MS;
    return new Promise<StorageDocEvent>((resolve) => {
      this.answers.set(ref, (event) => {
        const again = (ms: number) =>
          setTimeout(() => this.pending.has(ref) && this.transmit(ref, item), ms);
        if (event.type === "doc.refused" && event.reason === "editing" && !this.closed) {
          again(RETRY_MS);
          return;
        }
        if (event.type === "doc.refused" && event.reason === "unavailable" && !this.closed) {
          if (record.t === "update") {
            again(wait);
            wait = Math.min(wait * 2, UNAVAILABLE_MAX_MS);
            return;
          }
        }
        this.pending.delete(ref);
        this.answers.delete(ref);
        if (event.type === "doc.appended") this.markKnown(event.seqNum, record.t === "update");
        resolve(event);
      });
      this.transmit(ref, item);
    });
  }

  private transmit(ref: number, item: { record: StorageLiveRecord; matchSeqNum?: number }) {
    sendRealtime(this.options.orgId, {
      type: "doc.append",
      nodeId: this.options.nodeId,
      ref,
      ...item,
    });
  }

  private onRecord(seqNum: number, record: StorageLiveRecord) {
    if (record.t === "seed") {
      if (seqNum > this.epoch) this.options.onReplaced(record.cv);
      return;
    }
    this.apply({ seqNum, record }, false);
    if (seqNum > this.next) void this.catchUp();
  }

  private apply(entry: StorageLiveEntry, mine: boolean) {
    const { seqNum, record } = entry;
    if (seqNum < this.epoch || this.known.has(seqNum)) return;
    if (record.t === "seed" && seqNum !== this.epoch) return;
    if (record.t !== "seed" && record.e !== this.epoch) return this.markKnown(seqNum, false);
    if (record.t === "fold") {
      this.lastFold = Math.max(this.lastFold, record.s);
      this.options.onFolded(record.cv);
    } else {
      Y.applyUpdate(this.doc, fromBase64(record.u), REMOTE);
      if (record.t === "update" && seqNum > this.last.seqNum) this.last = { seqNum, mine };
    }
    this.markKnown(seqNum, false);
  }

  private markKnown(seqNum: number, mine: boolean) {
    this.known.add(seqNum);
    if (mine && seqNum > this.last.seqNum) this.last = { seqNum, mine };
    while (this.known.has(this.next)) this.next++;
  }

  private async catchUp() {
    if (this.catchingUp || this.closed) return;
    this.catchingUp = true;
    try {
      const entries = (await readAll(this.options.nodeId, this.next)) ?? [];
      for (const entry of entries) {
        if (entry.record.t === "seed" && entry.seqNum > this.epoch) {
          return this.options.onReplaced(entry.record.cv);
        }
        this.apply(entry, false);
      }
    } finally {
      this.catchingUp = false;
    }
  }
}
