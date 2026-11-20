import { Directory, File, Paths } from "expo-file-system";
import type { DrivePlace } from "./drive-actions.ts";

/** Where an upload goes, kept with it so a relaunch sends it to the same place. */
export interface UploadTarget {
  /** The workspace the upload goes to: every request names it, whatever the app is in later. */
  workspace: string;
  place: DrivePlace;
  /** The file this becomes a new version of. */
  replaces?: string | undefined;
}

/** Why a kept upload failed: enough to say why again and to decide whether Retry may work. */
export interface SavedError {
  status: number;
  code?: string | undefined;
  message: string;
}

/** An upload as it is kept on disk between launches. */
export interface SavedJob {
  id: number;
  name: string;
  size: number;
  mimeType: string | null;
  /** The app's own copy of the picked file, deleted once the upload ends either way. */
  uri: string;
  target: UploadTarget;
  /** The server's upload, once opened: a relaunch resumes from the parts it already has. */
  uploadId?: string | undefined;
  failed?: SavedError | undefined;
}

interface Saved {
  version: 1;
  owner: string;
  jobs: SavedJob[];
}

const queueFile = () => new File(Paths.document, "drive-uploads.json");
const sourcesDir = () => new Directory(Paths.cache, "drive-uploads", "sources");
/** Part files staged for the system's upload tasks, one folder per server upload. */
export const partsDir = () => new Directory(Paths.cache, "drive-uploads", "parts");

/** The jobs `owner` left unfinished, or none (nothing kept, another owner, or a corrupt file). */
export function loadJobs(owner: string) {
  const file = queueFile();
  if (!file.exists) return [];
  try {
    const saved = JSON.parse(file.textSync()) as Partial<Saved>;
    return saved.version === 1 && saved.owner === owner && Array.isArray(saved.jobs)
      ? saved.jobs
      : [];
  } catch {
    return [];
  }
}

/** Keeps `jobs` for the next launch; none left removes the file. */
export function saveJobs(owner: string, jobs: SavedJob[]) {
  const file = queueFile();
  if (!jobs.length) {
    if (file.exists) file.delete();
    return;
  }
  const saved: Saved = { version: 1, owner, jobs };
  file.write(JSON.stringify(saved));
}

/**
 * Moves a picked file into the app's own folder, so the picker's cache and a relaunch don't lose
 * it before it is sent. A move within the app's container is a rename: no bytes are copied.
 */
export function adoptSource(uri: string, id: number, name: string) {
  const dir = new Directory(sourcesDir(), String(id));
  dir.create({ intermediates: true, idempotent: true });
  const from = new File(uri);
  const to = new File(dir, safeFileName(name));
  if (to.exists) to.delete();
  from.moveSync(to);
  return from.uri;
}

/** Deletes the app's copy of job `id`'s file. */
export function dropSource(id: number) {
  const dir = new Directory(sourcesDir(), String(id));
  if (dir.exists) dir.delete();
}

/** Deletes every copy and staged part not in `keep` (left by a killed run, or a signed-out user). */
export function sweep(keep: { ids: number[]; uploadIds: string[] }) {
  const ids = new Set(keep.ids.map(String));
  const uploads = new Set(keep.uploadIds);
  for (const [dir, live] of [
    [sourcesDir(), ids],
    [partsDir(), uploads],
  ] as const) {
    if (!dir.exists) continue;
    for (const entry of dir.list()) if (!live.has(entry.name)) entry.delete();
  }
}

const safeFileName = (name: string) => name.replace(/[/:]/g, "_").trim() || "file";
