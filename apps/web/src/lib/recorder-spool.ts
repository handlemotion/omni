import type { ChunkSpool, SpooledChunk, SpooledStop } from "@omni/client";

const DB = "omni-recorder";
const RECORDINGS = "recordings";
const CHUNKS = "chunks";

/** A browser recording this computer still holds: going, or stopped and not yet sent whole. */
export interface SpooledRecording {
  meetingId: string;
  memberId: string;
  startedAt: number;
  stop: SpooledStop | null;
}

interface StoredChunk {
  meetingId: string;
  seq: number;
  sha256: string;
  endMs: number;
  blob: Blob;
  acked: boolean;
}

let opened: Promise<IDBDatabase> | undefined;

function database() {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDINGS, { keyPath: "meetingId" });
      request.result.createObjectStore(CHUNKS, { keyPath: ["meetingId", "seq"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
  return opened;
}

async function transact<T>(
  stores: string[],
  mode: IDBTransactionMode,
  act: (tx: IDBTransaction) => IDBRequest<T> | void,
) {
  const db = await database();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability: "strict" });
    const request = act(tx);
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

const range = (meetingId: string) => IDBKeyRange.bound([meetingId, 0], [meetingId, Infinity]);

const chunksOf = (meetingId: string) =>
  transact<StoredChunk[]>([CHUNKS], "readonly", (tx) =>
    tx.objectStore(CHUNKS).getAll(range(meetingId)),
  ).then((rows) => rows ?? []);

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keeps a new recording, before its first chunk, so a reload knows it was going. */
export const keepRecording = (recording: SpooledRecording) =>
  transact([RECORDINGS], "readwrite", (tx) => tx.objectStore(RECORDINGS).put(recording));

/** Writes a chunk to disk; only then is it sent. */
export async function keepChunk(meetingId: string, seq: number, endMs: number, blob: Blob) {
  const sha256 = await sha256Hex(await blob.arrayBuffer());
  const chunk: StoredChunk = { meetingId, seq, sha256, endMs, blob, acked: false };
  await transact([CHUNKS], "readwrite", (tx) => tx.objectStore(CHUNKS).put(chunk));
}

/** Notes the recorder's stop, so a reload finishes the meeting rather than waiting for chunks. */
export async function keepStop(meetingId: string, stop: SpooledStop) {
  await transact([RECORDINGS], "readwrite", (tx) => {
    const store = tx.objectStore(RECORDINGS);
    const got = store.get(meetingId) as IDBRequest<SpooledRecording | undefined>;
    got.onsuccess = () => {
      if (got.result) store.put({ ...got.result, stop } satisfies SpooledRecording);
    };
  });
}

/** The recordings this computer holds for a member: theirs to finish. */
export async function heldRecordings(memberId: string) {
  const all = await transact<SpooledRecording[]>([RECORDINGS], "readonly", (tx) =>
    tx.objectStore(RECORDINGS).getAll(),
  );
  return (all ?? []).filter((r) => r.memberId === memberId);
}

/** The last chunk kept for a recording, so a recording that never stopped can be stopped there. */
export async function lastChunk(meetingId: string) {
  const chunks = await chunksOf(meetingId);
  return chunks.reduce<StoredChunk | null>(
    (last, c) => (!last || c.seq > last.seq ? c : last),
    null,
  );
}

/** The spool `drainRecording` sends from. */
export const browserSpool: ChunkSpool = {
  async unsent(meetingId) {
    const chunks = (await chunksOf(meetingId)).filter((c) => !c.acked);
    chunks.sort((a, b) => a.seq - b.seq);
    return Promise.all(
      chunks.map(
        async (c) =>
          ({
            seq: c.seq,
            sha256: c.sha256,
            endMs: c.endMs,
            bytes: new Uint8Array(await c.blob.arrayBuffer()),
          }) satisfies SpooledChunk,
      ),
    );
  },
  async acknowledged(meetingId, seq) {
    await transact([CHUNKS], "readwrite", (tx) => {
      const store = tx.objectStore(CHUNKS);
      const got = store.get([meetingId, seq]) as IDBRequest<StoredChunk | undefined>;
      got.onsuccess = () => {
        if (got.result) store.put({ ...got.result, acked: true });
      };
    });
  },
  async resend(meetingId, seqs) {
    await transact([CHUNKS], "readwrite", (tx) => {
      const store = tx.objectStore(CHUNKS);
      for (const seq of seqs) {
        const got = store.get([meetingId, seq]) as IDBRequest<StoredChunk | undefined>;
        got.onsuccess = () => {
          if (got.result) store.put({ ...got.result, acked: false });
        };
      }
    });
  },
  async stopped(meetingId) {
    const recording = await transact<SpooledRecording | undefined>([RECORDINGS], "readonly", (tx) =>
      tx.objectStore(RECORDINGS).get(meetingId),
    );
    return recording?.stop ?? null;
  },
  async discard(meetingId) {
    await transact([RECORDINGS, CHUNKS], "readwrite", (tx) => {
      tx.objectStore(RECORDINGS).delete(meetingId);
      tx.objectStore(CHUNKS).delete(range(meetingId));
    });
  },
};
