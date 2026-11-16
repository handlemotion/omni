// The uploads in progress, outside React so they outlive the screen that started them: moving to
// another folder keeps them going. One file goes up at a time, in the order they were added; a
// failed one stays listed until it is retried (resuming from the parts the server has) or
// removed. `hooks/use-storage.ts` subscribes.
import type { QueryClient } from "@tanstack/react-query";
import { storageChanged, type StoragePlace } from "./storage.ts";
import { abortUpload, uploadFile } from "./storage-upload.ts";

export interface UploadItem {
  id: number;
  name: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  status: "queued" | "uploading" | "failed";
  /** Why it failed, as the API (or the network) said it: the screen words it. */
  error?: unknown;
}

interface Job extends UploadItem {
  file: File;
  place: StoragePlace;
  shareId: string | undefined;
  client: QueryClient;
  onFailed: (name: string, error: unknown) => void;
  uploadId?: string;
  controller?: AbortController;
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
    await uploadFile({
      file: job.file,
      place: job.place,
      shareId: job.shareId,
      resumeId: job.uploadId,
      signal: job.controller.signal,
      onOpened: (uploadId) => {
        job.uploadId = uploadId;
        // Removed while it was opening: `removeUpload` had no id to free yet.
        if (!jobs.includes(job)) void abortUpload(uploadId, job.shareId);
      },
      onProgress: (sent) => {
        job.sent = sent;
        publish();
      },
    });
    jobs = jobs.filter((j) => j !== job);
    void storageChanged(job.client);
  } catch (error) {
    // Removed while it ran: `removeUpload` already dropped it.
    if (jobs.includes(job)) {
      job.status = "failed";
      job.error = error;
      job.onFailed(job.name, error);
    }
  }
  publish();
  pump();
}

/** Starts the next queued file, unless one is on its way. */
function pump() {
  if (jobs.some((job) => job.status === "uploading")) return;
  const next = jobs.find((job) => job.status === "queued");
  if (next) void run(next);
}

/** Queues `files` for `target` (a place, through a shared link's door when `shareId` is set). `onFailed` is told each file that did not make it, with why. */
export function addUploads(
  client: QueryClient,
  files: File[],
  target: { place: StoragePlace; shareId?: string | undefined },
  onFailed: (name: string, error: unknown) => void,
) {
  for (const file of files) {
    jobs.push({
      id: nextId++,
      name: file.name,
      size: file.size,
      sent: 0,
      status: "queued",
      file,
      place: target.place,
      shareId: target.shareId,
      client,
      onFailed,
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
  if (job.uploadId)
    void abortUpload(job.uploadId, job.shareId).then(() => storageChanged(job.client));
  publish();
  pump();
}

/** For `useSyncExternalStore`. */
export const uploadsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): UploadItem[] => items,
};
