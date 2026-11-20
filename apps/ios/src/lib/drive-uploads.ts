import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { AppState } from "react-native";
import { useEffect, useSyncExternalStore } from "react";
import { ApiError } from "./api.ts";
import { driveNodeChanged } from "./drive-cache.ts";
import { abortUpload, uploadFile, type PickedFile } from "./drive-upload.ts";
import {
  adoptSource,
  dropSource,
  loadJobs,
  saveJobs,
  sweep,
  type SavedJob,
  type UploadTarget,
} from "./drive-upload-store.ts";
import { keys } from "./query-keys.ts";
import { queryClient } from "./query-client.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

export type { UploadTarget } from "./drive-upload-store.ts";

const FILES_AT_ONCE = 3;
const PUBLISH_MS = 250;

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  status: "preparing" | "queued" | "uploading" | "failed";
  error?: unknown;
}

interface Job extends UploadItem {
  file: PickedFile;
  target: UploadTarget;
  uploadId?: string | undefined;
  controller?: AbortController;
  running?: Promise<void>;
}

let jobs: Job[] = [];
let items: UploadItem[] = [];
let nextId = Date.now();
let owner: string | null = null;
const listeners = new Set<() => void>();

function publishNow() {
  timer = null;
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

let timer: ReturnType<typeof setTimeout> | null = null;
function publish() {
  timer ??= setTimeout(publishNow, PUBLISH_MS);
}

function persist() {
  if (!owner) return;
  saveJobs(
    owner,
    jobs
      .filter((job) => job.status !== "preparing")
      .map((job) => ({
        id: job.id,
        name: job.name,
        size: job.size,
        mimeType: job.file.mimeType,
        uri: job.file.uri,
        target: job.target,
        uploadId: job.uploadId,
        failed: job.status === "failed" ? savedError(job.error) : undefined,
      })),
  );
}

const savedError = (error: unknown) =>
  error instanceof ApiError
    ? { status: error.status, code: error.code, message: error.message }
    : { status: 0, message: error instanceof Error ? error.message : String(error) };

function finish(job: Job) {
  jobs = jobs.filter((j) => j !== job);
  dropSource(job.id);
  persist();
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
      workspace: job.target.workspace,
      signal: job.controller.signal,
      onOpened: (uploadId) => {
        if (!jobs.includes(job)) return void abortUpload(uploadId, job.target.workspace);
        job.uploadId = uploadId;
        persist();
      },
      onProgress: (sent) => {
        job.sent = sent;
        publish();
      },
    });
    const live = jobs.includes(job);
    finish(job);
    if (live && (currentWorkspaceId() ?? job.target.workspace) === job.target.workspace) {
      if (job.target.replaces) void queryClient.invalidateQueries({ queryKey: keys.driveAll() });
      else void driveNodeChanged(queryClient, node);
    }
  } catch (error) {
    if (jobs.includes(job)) {
      job.status = "failed";
      job.error = error;
      persist();
    }
  }
  job.controller = undefined;
  publish();
  pump();
}

function pump() {
  if (!owner) return;
  let running = jobs.filter((job) => job.status === "uploading").length;
  for (const job of jobs) {
    if (running >= FILES_AT_ONCE) break;
    if (job.status !== "queued") continue;
    running += 1;
    job.running = run(job);
  }
}

/**
 * Queues `files` for `target`, in `target.workspace`. Each picked file moves into the app's own
 * folder first ("preparing"), so it survives the app being killed until it has been sent.
 */
export function addUploads(files: PickedFile[], target: UploadTarget) {
  for (const file of files) {
    const job: Job = {
      id: nextId++,
      name: file.name,
      size: file.size,
      sent: 0,
      status: "preparing",
      file,
      target,
    };
    jobs.push(job);
    try {
      job.file = { ...file, uri: adoptSource(file.uri, job.id, file.name) };
      job.status = "queued";
    } catch (error) {
      job.status = "failed";
      job.error = error;
    }
  }
  persist();
  publishNow();
  pump();
}

/** Tries a failed upload again, from the parts the server already has. */
export function retryUpload(id: number) {
  const job = jobs.find((j) => j.id === id && j.status === "failed");
  if (!job) return;
  job.status = "queued";
  job.error = undefined;
  persist();
  publishNow();
  pump();
}

/** Cancels an upload (or drops a failed one) and frees what it held on the server. */
export function removeUpload(id: number) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.controller?.abort();
  if (job.uploadId) void abortUpload(job.uploadId, job.target.workspace);
  finish(job);
  publishNow();
  pump();
}

/**
 * Stops every upload, frees what each holds on the server, and forgets the kept queue. Call it
 * before the session ends or the account changes, so nothing queued by one person goes out under
 * the next one's cookie.
 */
export async function cancelUploads() {
  const all = jobs;
  jobs = [];
  for (const job of all) job.controller?.abort();
  if (owner) saveJobs(owner, []);
  owner = null;
  publishNow();
  for (const job of all) dropSource(job.id);
  await Promise.allSettled(all.map((job) => job.running));
  await Promise.allSettled(
    all.flatMap((job) => (job.uploadId ? [abortUpload(job.uploadId, job.target.workspace)] : [])),
  );
}

function revive(saved: SavedJob) {
  const file = { uri: saved.uri, name: saved.name, size: saved.size, mimeType: saved.mimeType };
  const job: Job = {
    id: saved.id,
    name: saved.name,
    size: saved.size,
    sent: 0,
    status: saved.failed ? "failed" : "queued",
    file,
    target: saved.target,
    uploadId: saved.uploadId,
  };
  if (saved.failed) {
    job.error = new ApiError(saved.failed.status, saved.failed.message, {
      code: saved.failed.code,
    });
  }
  if (!new File(saved.uri).exists) {
    job.status = "failed";
    job.error = new ApiError(404, "the picked file is gone", { code: "not_found" });
  }
  return job;
}

function resume(user: string) {
  if (owner === user) return pump();
  owner = user;
  const kept = loadJobs(user).map(revive);
  jobs = [...kept, ...jobs];
  nextId = Math.max(nextId, ...jobs.map((job) => job.id + 1));
  sweep({
    ids: jobs.map((job) => job.id),
    uploadIds: jobs.flatMap((job) => (job.uploadId ? [job.uploadId] : [])),
  });
  persist();
  publishNow();
  pump();
}

/**
 * Runs the upload queue for the signed-in `userId`: resumes what a killed run left, and starts
 * what waits each time the app comes back to the front. Mount once, at the root.
 */
export function useDriveUploads(userId: string | null) {
  useEffect(() => {
    if (!userId) return;
    resume(userId);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") pump();
    });
    return () => subscription.remove();
  }, [userId]);
}

const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  get: () => items,
};

/** The uploads on their way or failed, in every workspace, for the panel. */
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

/**
 * Photos and videos from the library, through the system picker (no permission prompt).
 * `original` keeps each as the library stores it (HEIC, HEVC) instead of converting it, as Drive
 * wants; a mail attachment leaves it off, so recipients get formats every client opens.
 */
export async function pickMedia({ original = false } = {}) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    quality: 1,
    ...(original
      ? {
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
          videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        }
      : {}),
  });
  if (result.canceled) return [] satisfies PickedFile[];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? asset.uri.split("/").pop() ?? "Photo",
    size: sizeOf(asset.uri, asset.fileSize),
    mimeType: asset.mimeType ?? null,
  }));
}
