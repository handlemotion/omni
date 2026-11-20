const DB = "omni-uploads";
const STORE = "open";
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface Saved {
  key: string;
  uploadId: string;
  savedAt: number;
}

export const resumeKey = (scope: string, file: File) =>
  `${scope}|${file.name}|${file.size}|${file.lastModified}`;

let opened: Promise<IDBDatabase | null> | undefined;

function database() {
  opened ??= new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    if (db) void sweep(db);
    return db;
  });
  return opened;
}

function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) {
  return database().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const request = act(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

async function sweep(db: IDBDatabase) {
  const cutoff = Date.now() - KEEP_MS;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const all = store.getAll() as IDBRequest<Saved[]>;
    all.onsuccess = () => {
      for (const saved of all.result) if (saved.savedAt < cutoff) store.delete(saved.key);
    };
  } catch {}
}

/** The upload kept for `key`, if this browser opened one and did not finish it. */
export async function savedUpload(key: string) {
  const saved = (await run("readonly", (store) => store.get(key))) as Saved | undefined;
  return saved && saved.savedAt >= Date.now() - KEEP_MS ? saved.uploadId : undefined;
}

export function saveUpload(key: string, uploadId: string) {
  return run("readwrite", (store) =>
    store.put({ key, uploadId, savedAt: Date.now() } satisfies Saved),
  );
}

export function forgetUpload(key: string) {
  return run("readwrite", (store) => store.delete(key));
}
