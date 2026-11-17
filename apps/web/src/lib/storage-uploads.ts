// The uploads in progress, outside React so they outlive the screen that started them: moving to
// another folder keeps them going. One file goes up at a time, in the order they were added; a
// failed one stays listed until it is retried (resuming from the parts the server has) or
// removed. `hooks/use-storage.ts` subscribes.
//
// An upload belongs to whoever queued it: the signed-in user and the active workspace, or the user
// and the link it goes through. Every switch of workspace or account cancels the queue first
// (`cancelUploads`, while the old session can still free what it reserved), and each request
// checks the session it would go out with, so a file never lands in another workspace.
import type { QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { Session } from "./session.ts";
import { storageChanged, type StorageNode, type StoragePlace } from "./storage.ts";
import { abortUpload, uploadFile } from "./storage-upload.ts";
import { storageNodeChanged } from "./storage-cache.ts";

export interface UploadTarget {
  place: StoragePlace;
  shareId?: string | undefined;
  replaces?: string | undefined;
}

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

/** Thrown when the session changed since the file was queued: it is not sent, and not retried. */
export class UploadIdentityChanged extends Error {
  readonly code = "identity_changed";
  constructor() {
    super("the session changed since this upload was queued");
  }
}

/** Who an upload goes out as: the user and the workspace, or the user and the shared link. */
export function identityOf(client: QueryClient, shareId: string | undefined) {
  const session = client.getQueryData<Session | null>(keys.session());
  if (!session) return null;
  const place = shareId ? `link:${shareId}` : `org:${session.member?.orgId ?? ""}`;
  return `${session.user.id}|${place}`;
}

/**
 * `uploadFile`'s `guard` and `confirm` for an upload that must go out as `identity`
 * (`identityOf`): the first checks this tab's session, the second asks the server, since another
 * tab may have switched the account or workspace without this tab's cache knowing.
 */
export function identityChecks(
  client: QueryClient,
  shareId: string | undefined,
  identity: string | null,
  signal: AbortSignal,
) {
  const guard = () => {
    if (identity === null || identityOf(client, shareId) !== identity) {
      throw new UploadIdentityChanged();
    }
  };
  return {
    guard,
    confirm: async () => {
      // Cancellable: a switch or sign-out waits for an upload, so a stalled read must not hold
      // it. Cancelled, it throws; any other failure falls back to this tab's cached session.
      const me = await call(api.me.$get(undefined, { init: { signal } })).catch(
        (error: unknown) => {
          if (signal.aborted) throw error;
          return null;
        },
      );
      if (!me) return guard();
      const place = shareId ? `link:${shareId}` : `org:${me.orgId}`;
      if (`${me.userId}|${place}` !== identity) throw new UploadIdentityChanged();
    },
  };
}

interface Job extends UploadItem {
  file: File;
  /** Who queued it (`identityOf`), or null when no one was signed in. */
  identity: string | null;
  /** Being cancelled by `cancelUploads`, which frees what it opened. */
  cancelled?: boolean;
  running?: Promise<void>;
  place: StoragePlace;
  /** The file it becomes a new version of, when it is one. */
  replaces: string | undefined;
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
    const node = await uploadFile({
      file: job.file,
      place: job.place,
      replaces: job.replaces,
      shareId: job.shareId,
      resumeId: job.uploadId,
      signal: job.controller.signal,
      onOpened: (uploadId) => {
        job.uploadId = uploadId;
        // Removed while it was opening: `removeUpload` had no id to free yet.
        if (!jobs.includes(job) && !job.cancelled) void abortUpload(uploadId, job.shareId);
      },
      // Opening a file is what places it, so that asks the server who this is first.
      ...identityChecks(job.client, job.shareId, job.identity, job.controller.signal),
      onProgress: (sent) => {
        job.sent = sent;
        publish();
      },
    });
    jobs = jobs.filter((j) => j !== job);
    void uploaded(job, node);
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

/**
 * A new file shows in its folder's cached list at once, and usage grows. A new version of a file
 * changes what hangs off it (its versions, its comments' content version, its signatures), and a
 * link's door has lists of its own: both refetch all of Storage.
 */
async function uploaded(job: Job, node: StorageNode) {
  if (job.shareId || job.replaces) return storageChanged(job.client);
  await storageNodeChanged(job.client, node);
  void job.client.invalidateQueries({ queryKey: keys.storageUsage() });
}

/** Starts the next queued file, unless one is on its way. */
function pump() {
  if (jobs.some((job) => job.status === "uploading")) return;
  const next = jobs.find((job) => job.status === "queued");
  if (next) next.running = run(next);
}

/**
 * Queues `files` for `target`: a place, through a shared link's door when `shareId` is set, or
 * with `replaces` a new version of that file. `onFailed` is told each file that did not make it,
 * with why.
 */
export function addUploads(
  client: QueryClient,
  files: File[],
  target: UploadTarget,
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
      replaces: target.replaces,
      shareId: target.shareId,
      identity: identityOf(client, target.shareId),
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

/**
 * Stops every upload and empties the queue, freeing on the server what each had opened. Call it
 * before the session changes workspace or account: the old session is the one that may free them.
 */
export async function cancelUploads() {
  const all = jobs;
  if (!all.length) return;
  jobs = [];
  publish();
  for (const job of all) {
    job.cancelled = true;
    job.controller?.abort();
  }
  // An upload still opening learns its id when the request answers: wait for each to stop.
  await Promise.allSettled(all.map((job) => job.running));
  await Promise.allSettled(
    all.flatMap((job) => (job.uploadId ? [abortUpload(job.uploadId, job.shareId)] : [])),
  );
}

/** For `useSyncExternalStore`. */
export const uploadsStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => items satisfies UploadItem[],
};
