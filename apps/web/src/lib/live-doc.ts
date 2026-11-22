import {
  DOC_PRESENCE_MAX,
  LIVE_SNAP_EVERY,
  LiveParts,
  type LiveWhole,
  type RealtimeClientMessage,
  type RealtimeEvent,
} from "@omni/client";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { memberChannel, sharedChannel, type LiveChannel, type SharedLive } from "./live-channel.ts";

export type { SharedLive } from "./live-channel.ts";

type StorageDocEvent = Extract<
  RealtimeEvent,
  { type: "doc.record" | "doc.appended" | "doc.refused" }
>;
type AwarenessChange = { added: number[]; updated: number[]; removed: number[] };
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
const ORPHAN_MS = 6000;
const ORPHAN_JITTER_MS = 4000;
const ORPHAN_RETRY_MAX_MS = 120_000;
const MAX_SNAP_CHARS = 850_000;

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const readAll: (
  channel: LiveChannel,
  nodeId: string,
  from?: number | "latest",
) => Promise<StorageLiveEntry[] | null> = async (channel, nodeId, from = "latest") => {
  const entries: StorageLiveEntry[] = [];
  for (let at = from; ;) {
    const page = await channel.read(nodeId, at);
    if (!page.enabled) return null;
    entries.push(...page.entries);
    const last = page.entries.at(-1);
    if (!page.more || !last) return entries;
    at = last.seqNum + 1;
  }
};

export interface LiveDocOptions {
  orgId: string;
  /**
   * Opened through a share link by someone outside the workspace: its own socket, and a reader
   * that never seeds, snaps or saves (the Worker does, `docs/spec/live-sharing.md`).
   */
  shared?: SharedLive | undefined;
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
  /**
   * The document holds changes nobody saved, and whoever made them has gone quiet (a closed tab,
   * a lost connection): save them, so the file does not lag behind its live document.
   */
  onOrphaned?: () => void;
}

/**
 * Joins the file's live document: its latest epoch when that epoch is the file's content now,
 * else a new epoch seeded from it. Null when the live layer is off.
 */
export async function openLiveDoc(options: LiveDocOptions) {
  for (let tries = 0; tries < 5; tries++) {
    const live = new LiveDoc(options);
    const entries = await live.readAll().catch((error: unknown) => {
      live.close();
      throw error;
    });
    if (!entries) {
      live.close();
      return null satisfies LiveDoc | null;
    }
    const joined = live.join(entries);
    if (joined === true) return live.start() satisfies LiveDoc | null;
    if (joined !== false) {
      live.close();
      options.onReplaced(joined);
      return null satisfies LiveDoc | null;
    }
    const tail = (entries.at(-1)?.seqNum ?? -1) + 1;
    if (!options.shared && (await live.seed(tail))) return live.start() satisfies LiveDoc | null;
    live.close();
  }
  throw new Error("the live document kept changing while it opened");
}

export class LiveDoc {
  readonly doc = new Y.Doc();
  /** Who else is in the document and where their cursor is; this tab's own state goes out too. */
  readonly awareness = new Awareness(this.doc);
  private epoch = -1;
  private known = new Set<number>();
  private next = 0;
  private last = { seqNum: -1, mine: false };
  private lastFold = -1;
  private foldCv = -1;
  private startAt = -1;
  private snapping = false;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;
  private orphanTries = 0;
  private folds = new Set<number>();
  private readonly parts = new LiveParts();
  private passedSnaps = new Set<number>();
  private pending = new Map<number, { record: StorageLiveRecord; matchSeqNum?: number }>();
  private answers = new Map<number, (event: StorageDocEvent) => void>();
  private batch: Uint8Array[] = [];
  private lost = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private catchingUp = false;
  private stops: (() => void)[] = [];
  private closed = false;
  private started = false;

  private readonly options: LiveDocOptions;
  private readonly channel: LiveChannel;
  private readonly commentListeners = new Set<() => void>();

  constructor(options: LiveDocOptions) {
    this.options = options;
    this.channel = options.shared
      ? sharedChannel(options.shared, options.nodeId)
      : memberChannel(options.orgId);
    this.stops.push(
      this.channel.onEvent((event) => {
        if (event.nodeId !== this.options.nodeId) return;
        if (event.type === "doc.presence") return this.onPresence(event.u);
        if (event.type === "doc.comments") {
          for (const listener of this.commentListeners) listener();
          return;
        }
        if (event.type === "doc.access") return this.options.shared?.onAccess(event.role);
        if (event.type !== "doc.record") return this.answers.get(event.ref)?.(event);
        if (this.started) this.onRecord(event.seqNum, event.record);
      }),
      this.channel.onOpen(() => {
        for (const [ref, item] of this.pending) this.transmit(ref, item);
        if (this.started) void this.catchUp();
        if (this.started) this.announce();
        if (this.started) this.watchOrphans();
      }),
    );
  }

  /**
   * Joins the latest epoch from the stream's records: true when joined, false when there is none
   * to join (none yet, or the file changed outside the live layer), or the content version the
   * epoch was saved as when that is newer than the file this tab read.
   */
  join(entries: StorageLiveEntry[]) {
    const joiner = new LiveParts();
    const whole = entries
      .flatMap((entry) => joiner.push(entry) ?? [])
      .toSorted((a, b) => a.seqNum - b.seqNum);
    let epoch = -1;
    for (const { seqNum, record: each } of whole) {
      if (each.t === "more") continue;
      epoch = Math.max(epoch, each.t === "seed" ? seqNum : each.e);
    }
    const first = whole.findLast(
      ({ seqNum, record: each }) =>
        (each.t === "seed" && seqNum === epoch) || (each.t === "snap" && each.e === epoch),
    );
    if (!first || (first.record.t !== "seed" && first.record.t !== "snap")) return false;
    const { record } = first;
    let cv = record.cv;
    for (const { record: each } of entries) {
      if (each.t === "fold" && each.e === epoch) cv = Math.max(cv, each.cv);
    }
    if (cv > this.options.contentVersion) return cv;
    if (cv !== this.options.contentVersion) return false;
    this.epoch = epoch;
    this.next = epoch;
    this.startAt = first.seqNum;
    this.foldCv = record.cv;
    this.lastFold = epoch;
    if (record.t === "snap") {
      Y.applyUpdate(this.doc, fromBase64(record.u), REMOTE);
      this.next = record.s + 1;
      this.lastFold = record.f;
      this.last = { seqNum: record.s, mine: false };
    }
    for (const entry of entries) {
      if (entry.seqNum >= this.next) this.apply(entry, false);
    }
    this.readThrough(entries);
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
    this.startAt = answer.seqNum;
    this.foldCv = this.options.contentVersion;
    this.lastFold = answer.seqNum;
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
    this.awareness.on("update", (change: AwarenessChange, origin: unknown) => {
      if (this.closed) return;
      if (origin !== REMOTE) return this.sendPresence([this.doc.clientID]);
      if (change.added.length > 0) this.announce();
    });
    let away: Record<string, unknown> | null = null;
    const leave = () => {
      clearTimeout(this.timer);
      this.flush();
      away = this.awareness.getLocalState();
      removeAwarenessStates(this.awareness, [this.doc.clientID], "close");
    };
    const back = (event: PageTransitionEvent) => {
      if (event.persisted && away && !this.closed) this.awareness.setLocalState(away);
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    this.stops.push(() => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    });
    this.started = true;
    void this.catchUp();
    this.announce();
    this.watchOrphans();
    return this;
  }

  /** Whether this tab wrote the epoch's last change and it has not been saved since. */
  get needsFold() {
    if (this.options.shared) return false;
    return this.last.mine && this.last.seqNum > this.lastFold && this.pending.size === 0;
  }

  /** Changes this tab made that the stream has not taken yet. */
  get unsent() {
    return this.lost || this.batch.length > 0 || this.pendingUpdates();
  }

  /** Opened through a share link: the Worker saves what this tab types. */
  get outsider() {
    return !!this.options.shared;
  }

  /** The document's records from `from`, read through its channel; null when the layer is off. */
  readAll(from: number | "latest" = "latest") {
    return readAll(this.channel, this.options.nodeId, from);
  }

  /** Calls `listener` when someone changes the doc's comments (`doc.comments`). */
  onComments(listener: () => void) {
    this.commentListeners.add(listener);
    return () => this.commentListeners.delete(listener);
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
    if (answer.type !== "doc.appended") return;
    this.lastFold = Math.max(this.lastFold, boundary);
    this.foldCv = Math.max(this.foldCv, contentVersion);
  }

  /**
   * Whether this document was saved as `contentVersion`, by this tab or anyone in it (an agent
   * too): then a save that found the file at that version lost nothing. Waits a while for the
   * record, since the save itself can be heard first.
   */
  async savedAs(contentVersion: number) {
    const until = Date.now() + SETTLE_MS;
    while (!this.folds.has(contentVersion) && Date.now() < until && !this.closed) {
      void this.catchUp();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.folds.has(contentVersion);
  }

  /** Sends this tab's changes now and waits (a while) for the stream to take them all: whether it did. */
  async settle() {
    clearTimeout(this.timer);
    this.flush();
    const until = Date.now() + SETTLE_MS;
    while (this.pendingUpdates() && Date.now() < until && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !this.closed && !this.unsent;
  }

  private pendingUpdates() {
    return [...this.pending.values()].some((item) => item.record.t === "update");
  }

  close() {
    if (this.started) removeAwarenessStates(this.awareness, [this.doc.clientID], "close");
    this.awareness.destroy();
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.orphanTimer);
    for (const stop of this.stops) stop();
    this.channel.close();
    for (const resolve of this.answers.values()) {
      resolve({ type: "doc.refused", nodeId: this.options.nodeId, ref: 0, reason: "unavailable" });
    }
    this.doc.destroy();
  }

  private onPresence(update: string) {
    if (!this.started || this.closed) return;
    try {
      applyAwarenessUpdate(this.awareness, fromBase64(update), REMOTE);
    } catch {}
  }

  private announce() {
    if (this.awareness.getLocalState()) this.sendPresence([this.doc.clientID]);
  }

  private sendPresence(clients: number[]) {
    const u = toBase64(encodeAwarenessUpdate(this.awareness, clients));
    if (u.length > DOC_PRESENCE_MAX) return;
    this.channel.send({ type: "doc.presence", nodeId: this.options.nodeId, u });
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
      this.snapIfDue(answer.seqNum);
    });
  }

  private snapIfDue(seqNum: number) {
    if (this.options.shared) return;
    if (this.snapping || this.closed || seqNum - this.startAt < LIVE_SNAP_EVERY) return;
    const s = this.boundary;
    if (s <= this.startAt) return;
    const u = toBase64(Y.encodeStateAsUpdate(this.doc));
    if (u.length > MAX_SNAP_CHARS) return;
    const f = Math.max(this.lastFold, this.epoch);
    this.snapping = true;
    void this.sendOnce({ t: "snap", e: this.epoch, s, cv: this.foldCv, f, u })
      .then((answer) => {
        if (answer?.type === "doc.appended") this.startAt = Math.max(this.startAt, answer.seqNum);
      })
      .finally(() => {
        this.snapping = false;
      });
  }

  private sendOnce(record: StorageLiveRecord) {
    const ref = nextRef++;
    return new Promise<StorageDocEvent | null>((resolve) => {
      const timer = setTimeout(() => {
        this.answers.delete(ref);
        resolve(null);
      }, SETTLE_MS);
      this.answers.set(ref, (event) => {
        clearTimeout(timer);
        this.answers.delete(ref);
        if (event.type === "doc.appended") this.markKnown(event.seqNum, false);
        resolve(event);
      });
      this.transmit(ref, { record });
    });
  }

  private watchOrphans(retry = false) {
    clearTimeout(this.orphanTimer);
    if (this.closed || !this.options.onOrphaned) return;
    this.orphanTries = retry ? this.orphanTries + 1 : 0;
    const wait = Math.min(ORPHAN_MS * 2 ** this.orphanTries, ORPHAN_RETRY_MAX_MS);
    this.orphanTimer = setTimeout(
      () => {
        const orphaned = this.last.seqNum > this.lastFold && !this.last.mine;
        if (this.closed || !orphaned) return;
        if (this.pending.size === 0) this.options.onOrphaned?.();
        this.watchOrphans(true);
      },
      wait + Math.random() * ORPHAN_JITTER_MS,
    );
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
        const retried = event.type === "doc.refused" && /^(unavailable|rate)$/.test(event.reason);
        if (retried && !this.closed) {
          if (record.t === "update") {
            again(wait);
            wait = Math.min(wait * 2, UNAVAILABLE_MAX_MS);
            return;
          }
        }
        this.pending.delete(ref);
        this.answers.delete(ref);
        const refused = event.type === "doc.refused" && record.t === "update";
        if (refused && this.options.shared) this.lost = true;
        if (event.type === "doc.appended") this.markKnown(event.seqNum, record.t === "update");
        resolve(event);
      });
      this.transmit(ref, item);
    });
  }

  private transmit(ref: number, item: { record: StorageLiveRecord; matchSeqNum?: number }) {
    this.channel.send({ type: "doc.append", nodeId: this.options.nodeId, ref, ...item });
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
    if (entry.seqNum < this.epoch || this.known.has(entry.seqNum)) return;
    const { record } = entry;
    if (record.t === "more" && this.passedSnaps.has(record.h)) {
      return this.markKnown(entry.seqNum, false);
    }
    const whole = this.parts.push(entry);
    if (!whole && record.t === "snap") {
      this.passedSnaps.add(entry.seqNum);
      for (const seqNum of this.parts.drop(entry.seqNum)) this.markKnown(seqNum, false);
    }
    if (!whole) return;
    this.use(whole, mine);
    for (const seqNum of whole.seqNums) this.markKnown(seqNum, false);
    if (this.started) this.watchOrphans();
  }

  private use(entry: LiveWhole, mine: boolean) {
    const { seqNum, record, completedAt } = entry;
    if (record.t === "more") return;
    if (record.t === "seed" && seqNum !== this.epoch) return;
    if (record.t !== "seed" && record.e !== this.epoch) return;
    if (record.t === "fold") {
      this.lastFold = Math.max(this.lastFold, record.s);
      this.foldCv = Math.max(this.foldCv, record.cv);
      this.folds.add(record.cv);
      this.options.onFolded(record.cv);
    } else {
      Y.applyUpdate(this.doc, fromBase64(record.u), REMOTE);
      if (record.t === "update" && completedAt > this.last.seqNum) {
        this.last = { seqNum: completedAt, mine };
      }
      if (record.t === "snap") this.startAt = Math.max(this.startAt, seqNum);
    }
  }

  private readThrough(entries: StorageLiveEntry[]) {
    const end = entries.at(-1)?.seqNum;
    if (end === undefined) return;
    for (const seqNum of this.parts.abandon(end + 1)) this.markKnown(seqNum, false);
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
      const entries = (await this.readAll(this.next)) ?? [];
      for (const entry of entries) {
        if (entry.record.t === "seed" && entry.seqNum > this.epoch) {
          return this.options.onReplaced(entry.record.cv);
        }
        this.apply(entry, false);
      }
      this.readThrough(entries);
    } finally {
      this.catchingUp = false;
    }
  }
}
