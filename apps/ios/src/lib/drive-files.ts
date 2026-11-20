import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Directory, DownloadTask, File, Paths, type DownloadPauseState } from "expo-file-system";
import { config } from "./config.ts";
import { storageHeaders } from "./drive.ts";

/** How much of the phone the cache of Drive copies may take before the least recently used go. */
export const CACHE_CAP_BYTES = 1024 * 1024 * 1024;

const CHECKPOINT_BYTES = 256 * 1024 * 1024;
const IN_USE_MS = 10 * 60_000;
const SAVE_INDEX_MS = 1_000;
const PROGRESS_MS = 250;

const ON_DEVICE = Platform.OS !== "web";
const cacheDir = () => new Directory(Paths.cache, "drive-files");
const offlineDir = () => new Directory(Paths.document, "drive-offline");
const legacyDirs = () => [
  new Directory(Paths.cache, "drive"),
  new Directory(Paths.cache, "drive-preview"),
];

/** A file's bytes as one download names them: the file at a version, or one kept version. */
export interface FileSource {
  id: string;
  name: string;
  /** The file's `contentVersion` (or a kept version's id): a new one is a new copy. */
  version: string;
  /** A kept version's id; the file's current bytes without it. */
  versionId?: string;
}

/** One download in flight, as the downloads panel draws it. */
export interface DownloadItem {
  key: string;
  name: string;
  written: number;
  total: number;
  /** Asked for by the person (Save to Files, Make available offline), not a preview filling in. */
  shown: boolean;
}

interface Entry {
  bytes: number;
  usedAt: number;
}

interface Pin {
  version: string;
  name: string;
}

interface Transfer {
  item: DownloadItem;
  done: Promise<File>;
  abort: AbortController;
  checkpoint: () => void;
}

/** A file name the phone's file system takes: no path separators, never empty. */
export const safeName = (name: string) => name.replace(/[/\\:]/g, "_").trim() || "File";

/** Where a file's bytes are, for a native view that loads them itself. */
export const contentUrl = (fileId: string, versionId?: string) =>
  `${config.apiUrl}/api/storage/files/${encodeURIComponent(fileId)}${
    versionId ? `/versions/${encodeURIComponent(versionId)}` : ""
  }/content`;

const keyOf = (source: FileSource) =>
  `${source.id}/${source.versionId ? `v-${source.versionId}` : source.version}`;

const folderOf = (root: Directory, source: FileSource) =>
  new Directory(root, source.id, source.versionId ? `v-${source.versionId}` : source.version);

const transfers = new Map<string, Transfer>();
const listeners = new Set<() => void>();
let snapshot: DownloadItem[] = [];
let index: Record<string, Entry> | null = null;
let pins: Record<string, Pin> | null = null;
let indexTimer: ReturnType<typeof setTimeout> | undefined;
let announceTimer: ReturnType<typeof setTimeout> | undefined;

function announce() {
  clearTimeout(announceTimer);
  announceTimer = undefined;
  snapshot = [...transfers.values()].map((one) => ({ ...one.item }));
  for (const listener of listeners) listener();
}

function announceSoon() {
  announceTimer ??= setTimeout(announce, PROGRESS_MS);
}

function readJson<T>(file: File, fallback: T) {
  if (!file.exists) return fallback;
  try {
    return JSON.parse(file.textSync()) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: File, value: unknown) {
  if (!file.parentDirectory.exists) file.parentDirectory.create({ intermediates: true });
  file.write(JSON.stringify(value));
}

const indexFile = () => new File(cacheDir(), "index.json");
const pinsFile = () => new File(offlineDir(), "pins.json");

function loadIndex() {
  if (index) return index;
  if (!ON_DEVICE) return (index = {});
  for (const old of legacyDirs()) if (old.exists) old.delete();
  index = readJson<Record<string, Entry>>(indexFile(), {});
  return index;
}

function loadPins() {
  pins ??= ON_DEVICE ? readJson<Record<string, Pin>>(pinsFile(), {}) : {};
  return pins;
}

function saveIndexSoon() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => index && writeJson(indexFile(), index), SAVE_INDEX_MS);
}

function evict(keep: string) {
  const entries = loadIndex();
  let total = Object.values(entries).reduce((sum, one) => sum + one.bytes, 0);
  if (total <= CACHE_CAP_BYTES) return;
  const now = Date.now();
  const oldest = Object.entries(entries).toSorted(([, a], [, b]) => a.usedAt - b.usedAt);
  for (const [key, entry] of oldest) {
    if (total <= CACHE_CAP_BYTES) break;
    if (key === keep || transfers.has(key) || now - entry.usedAt < IN_USE_MS) continue;
    const folder = new Directory(cacheDir(), ...key.split("/"));
    if (folder.exists) folder.delete();
    delete entries[key];
    total -= entry.bytes;
  }
}

function used(key: string, bytes: number) {
  loadIndex()[key] = { bytes, usedAt: Date.now() };
  evict(key);
  saveIndexSoon();
}

function drop(file: File) {
  if (file.exists) file.delete();
}

function resumeFile(file: File) {
  return new File(file.parentDirectory, `.${file.name}.resume.json`);
}

async function startTask(
  url: string,
  file: File,
  onProgress: (written: number, total: number) => void,
) {
  const headers = await storageHeaders();
  const progress = ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) =>
    onProgress(bytesWritten, totalBytes);
  const saved = readJson<DownloadPauseState | null>(resumeFile(file), null);
  if (saved?.resumeData && saved.url === url && saved.fileUri === file.uri) {
    const task = DownloadTask.fromSavable(saved, { headers, onProgress: progress });
    return { task, resumed: true, first: () => task.resumeAsync() };
  }
  const task = File.createDownloadTask(url, file, { headers, onProgress: progress });
  return { task, resumed: false, first: () => task.downloadAsync() };
}

function transfer(key: string, url: string, file: File, name: string, shown: boolean) {
  const abort = new AbortController();
  const item: DownloadItem = { key, name, written: 0, total: 0, shown };
  let task: DownloadTask | undefined;
  let pauseAsked = false;
  let nextCheckpoint = CHECKPOINT_BYTES;
  const checkpoint = () => {
    if (task?.state !== "active" || pauseAsked) return;
    pauseAsked = true;
    task.pause();
  };
  const onProgress = (written: number, total: number) => {
    item.written = written;
    if (total > 0) item.total = total;
    if (written >= nextCheckpoint) {
      nextCheckpoint = written + CHECKPOINT_BYTES;
      checkpoint();
    }
    announceSoon();
  };
  const cancel = () => task?.cancel();
  const begin = async () => {
    const started = await startTask(url, file, onProgress);
    task = started.task;
    if (abort.signal.aborted) task.cancel();
    if (!started.resumed) return started.first();
    const resumed = await started.first().then(
      (copy) => ({ copy }),
      () => null,
    );
    if (resumed) return resumed.copy;
    drop(resumeFile(file));
    const fresh = await startTask(url, file, onProgress);
    task = fresh.task;
    return fresh.first();
  };
  const run = async () => {
    file.parentDirectory.create({ intermediates: true, idempotent: true });
    abort.signal.addEventListener("abort", cancel);
    let result = await begin();
    while (!result) {
      if (abort.signal.aborted || !task) throw new Error("cancelled");
      writeJson(resumeFile(file), { ...task.savable(), headers: undefined });
      pauseAsked = false;
      result = await task.resumeAsync();
    }
    return result;
  };
  const done = run()
    .catch((error: unknown) => {
      drop(file);
      if (abort.signal.aborted) drop(resumeFile(file));
      throw error;
    })
    .finally(() => {
      abort.signal.removeEventListener("abort", cancel);
      if (file.exists) drop(resumeFile(file));
      task?.release();
    });
  return { item, done, abort, checkpoint } satisfies Transfer;
}

function bytesOf(file: File) {
  return file.size ?? 0;
}

/**
 * The phone's copy of `source` under its own name, downloading it once: a pinned copy (Make
 * available offline) first, then the cache. Two callers asking for the same bytes share one
 * download. `shown` puts it in the downloads panel, with its progress and Cancel.
 *
 * The download is a background download task that pauses at a checkpoint (every
 * `CHECKPOINT_BYTES`, and whenever the app leaves the foreground) to keep its resume data on
 * disk, so one the app was killed during picks up from there on the next try: the Worker answers
 * the `Range` with `206` while the file's `ETag` still matches.
 */
export function localFile(source: FileSource & { size?: number }, shown = false) {
  const key = keyOf(source);
  const existing = existingCopy(source);
  if (existing) {
    if (existing.parentDirectory.uri.startsWith(cacheDir().uri)) used(key, bytesOf(existing));
    return Promise.resolve(existing);
  }
  const file = new File(folderOf(cacheDir(), source), safeName(source.name));
  const running = transfers.get(key);
  if (running) {
    if (shown && !running.item.shown) {
      running.item.shown = true;
      announce();
    }
    return running.done;
  }
  const started = transfer(key, contentUrl(source.id, source.versionId), file, source.name, shown);
  started.item.total = source.size ?? 0;
  transfers.set(key, started);
  announce();
  return started.done
    .then((copy) => {
      used(key, bytesOf(copy));
      return copy;
    })
    .finally(() => {
      transfers.delete(key);
      announce();
    });
}

/** The phone's finished copy of `source` (pinned or cached), or null without downloading it. */
export function existingCopy(source: FileSource) {
  if (!ON_DEVICE) return null;
  const pin = loadPins()[source.id];
  if (pin && !source.versionId && pin.version === source.version) {
    const pinned = new File(folderOf(offlineDir(), source), safeName(pin.name));
    if (pinned.exists) return pinned;
  }
  const file = new File(folderOf(cacheDir(), source), safeName(source.name));
  return file.exists && !resumeFile(file).exists ? file : null;
}

/** Stops a download and throws its partial bytes away. */
export function cancelDownload(key: string) {
  transfers.get(key)?.abort.abort();
}

/** Downloads in flight, for the downloads panel. */
export const useDownloads = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => snapshot,
  );

/** Whether `fileId` is kept on the phone for use offline. */
export const isPinned = (fileId: string) => !!loadPins()[fileId];

/** Whether `fileId` is pinned, as a hook that redraws when pins change. */
export const usePinned = (fileId: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => isPinned(fileId),
  );

/**
 * Keeps `source` on the phone for use offline: downloaded into the app's documents, which iOS
 * never clears and the cache cap never counts. A new version replaces the pinned one the next
 * time the file is opened or the pin is refreshed.
 */
export async function pinFile(source: FileSource & { size?: number }) {
  const all = loadPins();
  const cached = await localFile(source, true);
  const folder = folderOf(offlineDir(), source);
  const old = new Directory(offlineDir(), source.id);
  if (old.exists) old.delete();
  folder.create({ intermediates: true, idempotent: true });
  cached.copy(new File(folder, safeName(source.name)));
  all[source.id] = { version: source.version, name: source.name };
  writeJson(pinsFile(), all);
  announce();
}

/** Lets a pinned file go: its copy is deleted, and the cache downloads it again when needed. */
export function unpinFile(fileId: string) {
  const all = loadPins();
  delete all[fileId];
  const folder = new Directory(offlineDir(), fileId);
  if (folder.exists) folder.delete();
  writeJson(pinsFile(), all);
  announce();
}

/**
 * Brings each pinned file in `nodes` up to its current version, so what is available offline is
 * what Drive shows.
 */
export function refreshPins(nodes: readonly (FileSource & { size?: number })[]) {
  const all = loadPins();
  for (const node of nodes) {
    const pin = all[node.id];
    if (pin && pin.version !== node.version && !transfers.has(keyOf(node))) {
      void pinFile(node).catch(() => undefined);
    }
  }
}

/**
 * Deletes every Drive copy on the phone, pinned ones too, and stops their downloads: on sign out
 * and when another account signs in, so the next person never reads the last one's files.
 */
export function forgetDriveFiles() {
  for (const one of transfers.values()) one.abort.abort();
  clearTimeout(indexTimer);
  if (ON_DEVICE) {
    for (const folder of [cacheDir(), offlineDir(), ...legacyDirs()]) {
      if (folder.exists) folder.delete();
    }
  }
  index = {};
  pins = {};
  announce();
}

AppState.addEventListener("change", (state) => {
  if (state === "active") return;
  for (const one of transfers.values()) one.checkpoint();
});
