import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Alert } from "react-native";
import { useSyncExternalStore } from "react";
import { driveErrorText, type DrivePlace } from "./drive-actions.ts";
import { driveNodeChanged } from "./drive-cache.ts";
import { abortUpload, uploadFile, type PickedFile } from "./drive-upload.ts";
import { keys } from "./query-keys.ts";
import { queryClient } from "./query-client.ts";
import { currentWorkspaceId, subscribeWorkspaceId } from "./workspace-id.ts";

export interface UploadTarget {
  /** The workspace the upload goes to: every request names it, whatever the app is in later. */
  workspace: string;
  place: DrivePlace;
  /** The file this becomes a new version of. */
  replaces?: string | undefined;
}

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  status: "queued" | "uploading" | "failed";
  error?: unknown;
}

interface Job extends UploadItem {
  file: PickedFile;
  target: UploadTarget;
  workspace: string;
  uploadId?: string;
  controller?: AbortController;
  running?: Promise<void>;
}

let jobs: Job[] = [];
let items: UploadItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish() {
  items = jobs.map(({ id, name, size, sent, status, error }) => ({
    id,
    name,
    size,
    sent,
    status,
    error,
  }));
  for (const listener of listeners) listener();
}

async function run(job: Job) {
  job.status = "uploading";
  job.controller = new AbortController();
  publish();
  try {
    const node = await uploadFile({
      file: job.file,
      place: job.target.place,
      replaces: job.target.replaces,
      resumeId: job.uploadId,
      workspace: job.workspace,
      signal: job.controller.signal,
      onOpened: (uploadId) => {
        job.uploadId = uploadId;
        if (!jobs.includes(job)) void abortUpload(uploadId, job.workspace);
      },
      onProgress: (sent) => {
        job.sent = sent;
        publish();
      },
    });
    const live = jobs.includes(job);
    jobs = jobs.filter((j) => j !== job);
    if (live && (currentWorkspaceId() ?? job.workspace) === job.workspace) {
      if (job.target.replaces) void queryClient.invalidateQueries({ queryKey: keys.driveAll() });
      else void driveNodeChanged(queryClient, node);
    }
  } catch (error) {
    if (jobs.includes(job)) {
      job.status = "failed";
      job.error = error;
      Alert.alert(driveErrorText(error, `“${job.name}” was not uploaded`));
    }
  }
  publish();
  pump();
}

function pump() {
  if (jobs.some((job) => job.status === "uploading")) return;
  const next = jobs.find((job) => job.status === "queued");
  if (next) next.running = run(next);
}

/** Queues `files` for `target`, one at a time, in `target.workspace`. */
export function addUploads(files: PickedFile[], target: UploadTarget) {
  const { workspace } = target;
  for (const file of files) {
    jobs.push({
      id: nextId++,
      name: file.name,
      size: file.size,
      sent: 0,
      status: "queued",
      file,
      target,
      workspace,
    });
  }
  publish();
  pump();
}

/** Tries a failed upload again, from the parts the server already has. */
export function retryUpload(id: number) {
  const job = jobs.find((j) => j.id === id && j.status === "failed");
  if (!job) return;
  job.status = "queued";
  job.error = undefined;
  publish();
  pump();
}

/** Cancels an upload (or drops a failed one) and frees what it held on the server. */
export function removeUpload(id: number) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  jobs = jobs.filter((j) => j !== job);
  job.controller?.abort();
  if (job.uploadId) void abortUpload(job.uploadId, job.workspace);
  publish();
  pump();
}

async function cancel(drop: (job: Job) => boolean) {
  const all = jobs.filter(drop);
  if (!all.length) return;
  jobs = jobs.filter((job) => !all.includes(job));
  for (const job of all) job.controller?.abort();
  publish();
  pump();
  await Promise.allSettled(all.map((job) => job.running));
  await Promise.all(
    all.flatMap((job) => (job.uploadId ? [abortUpload(job.uploadId, job.workspace)] : [])),
  );
}

subscribeWorkspaceId(() => {
  const now = currentWorkspaceId();
  if (now) void cancel((job) => job.workspace !== now);
});

/**
 * Stops every upload and frees what each holds on the server. Call it before the session ends or
 * the account changes, so nothing queued by one person goes out under the next one's cookie.
 */
export const cancelUploads = () => cancel(() => true);

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  get: () => items,
};

/** The uploads on their way or failed, for the panel. */
export const useUploads = () => useSyncExternalStore(store.subscribe, store.get);

const sizeOf = (uri: string, size: number | null | undefined) => size ?? new File(uri).size;

/** Files from the Files app (iCloud Drive, On My iPhone, other providers), several at once. */
export async function pickDocuments() {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [] satisfies PickedFile[];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    size: sizeOf(asset.uri, asset.size),
    mimeType: asset.mimeType ?? null,
  }));
}

/** Photos and videos from the library, through the system picker (no permission prompt). */
export async function pickMedia() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return [] satisfies PickedFile[];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? asset.uri.split("/").pop() ?? "Photo",
    size: sizeOf(asset.uri, asset.fileSize),
    mimeType: asset.mimeType ?? null,
  }));
}
