import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { api, ApiError, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { Session } from "./session.ts";
import { storageChanged, type StorageNode, type StoragePlace } from "./storage.ts";
import { abortUpload, uploadFile } from "./storage-upload.ts";
import { isTransient, Slots } from "./storage-upload-net.ts";
import { forgetUpload, resumeKey, savedUpload, saveUpload } from "./storage-upload-resume.ts";
import { FolderMaker, type Picked } from "./storage-upload-tree.ts";
import { storageFolderMade, storageListsRefresh, storageNodesChanged } from "./storage-cache.ts";

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

const FILES_AT_ONCE = 6;
const REQUESTS_AT_ONCE = 6;
const PUBLISH_MS = 250;
const LAND_MS = 1000;

const slots = new Slots(REQUESTS_AT_ONCE);

const STOPS_BATCH = new Set([
  "storage_full",
  "billing_inactive",
  "identity_changed",
  "forbidden",
  "parent_trashed",
  "not_found",
]);

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

interface Batch {
  client: QueryClient;
  target: UploadTarget;
  identity: string | null;
  onFailed: (name: string, error: unknown) => void;
  checks: ReturnType<typeof identityChecks>;
  confirmed?: Promise<void> | undefined;
  folders: FolderMaker | null;
  pending: number;
  touched: QueryKey[];
  landed: StorageNode[];
  landing?: ReturnType<typeof setTimeout> | undefined;
  changed: boolean;
  told: Set<string>;
}

interface Job extends UploadItem {
  file: File;
  dir: string[];
  batch: Batch;
  resume?: string | undefined;
  cancelled?: boolean;
  running?: Promise<void>;
  uploadId?: string;
  controller?: AbortController;
  view?: UploadItem;
}

let jobs: Job[] = [];
let items: UploadItem[] = [];
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const viewOf = (job: Job) => {
  const { id, name, size, sent, status, error, view } = job;
  if (
    view &&
    view.sent === sent &&
    view.status === status &&
    view.error === error &&
    view.name === name
  ) {
    return view;
  }
  job.view = { id, name, size, sent, status, error };
  return job.view;
};

function publish() {
  clearTimeout(timer);
  timer = undefined;
  items = jobs.map(viewOf);
  holdTheTab(jobs.some((job) => job.status !== "failed"));
  for (const listener of listeners) listener();
}

function publishSoon() {
  timer ??= setTimeout(publish, PUBLISH_MS);
}

let holding = false;
const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
function holdTheTab(busy: boolean) {
  if (busy === holding || typeof window === "undefined") return;
  holding = busy;
  if (busy) window.addEventListener("beforeunload", warnBeforeLeaving);
  else window.removeEventListener("beforeunload", warnBeforeLeaving);
}

const confirmOnce = (batch: Batch) => () =>
  (batch.confirmed ??= batch.checks.confirm().catch((error: unknown) => {
    batch.confirmed = undefined;
    throw error;
  }));

async function run(job: Job) {
  const { batch } = job;
  job.status = "uploading";
  job.controller = new AbortController();
  const { signal } = job.controller;
  publishSoon();
  try {
    const place = batch.folders
      ? await batch.folders.placeFor(job.dir, signal)
      : batch.target.place;
    if (!job.uploadId && job.resume) job.uploadId = await savedUpload(job.resume);
    const node = await uploadFile({
      file: job.file,
      place,
      replaces: batch.target.replaces,
      shareId: batch.target.shareId,
      resumeId: job.uploadId,
      signal,
      slots,
      onOpened: (uploadId) => {
        job.uploadId = uploadId;
        if (job.resume) void saveUpload(job.resume, uploadId);
        if (!jobs.includes(job) && !job.cancelled) void abortUpload(uploadId, batch.target.shareId);
      },
      guard: batch.checks.guard,
      confirm: confirmOnce(batch),
      onProgress: (sent) => {
        job.sent = sent;
        publishSoon();
      },
    });
    jobs = jobs.filter((j) => j !== job);
    if (job.resume) void forgetUpload(job.resume);
    uploaded(batch, node);
  } catch (error) {
    if (jobs.includes(job)) fail(job, error);
  }
  publishSoon();
  pump();
  void finish(batch);
}

function fail(job: Job, error: unknown) {
  const { batch } = job;
  job.status = "failed";
  job.error = error;
  if (STOPS_BATCH.has(codeOf(error) ?? "")) {
    for (const other of jobs) {
      if (other.batch !== batch || other.status !== "queued") continue;
      other.status = "failed";
      other.error = error;
    }
  }
  tell(batch, job.name, error);
}

function tell(batch: Batch, name: string, error: unknown) {
  const cause = codeOf(error) ?? `status:${error instanceof ApiError ? error.status : "?"}`;
  if (batch.told.has(cause)) return;
  batch.told.add(cause);
  batch.onFailed(name, error);
}

function uploaded(batch: Batch, node: StorageNode) {
  if (batch.target.shareId || batch.target.replaces) {
    batch.changed = true;
    return;
  }
  batch.landed.push(node);
  batch.landing ??= setTimeout(() => void land(batch), LAND_MS);
}

async function land(batch: Batch) {
  clearTimeout(batch.landing);
  batch.landing = undefined;
  const nodes = batch.landed;
  batch.landed = [];
  if (!nodes.length) return;
  batch.touched.push(...(await storageNodesChanged(batch.client, nodes, { refresh: false })));
}

async function finish(batch: Batch) {
  const busy = jobs.some((job) => job.batch === batch && job.status !== "failed");
  if (busy || batch.pending > 0) return;
  await land(batch);
  const { client, touched, changed } = batch;
  batch.touched = [];
  batch.changed = false;
  if (changed) void storageChanged(client);
  else if (touched.length) {
    void storageListsRefresh(client, touched);
    void client.invalidateQueries({ queryKey: keys.storageUsage() });
  }
}

function pump() {
  let running = jobs.filter((job) => job.status === "uploading").length;
  for (const job of jobs) {
    if (running >= FILES_AT_ONCE) return;
    if (job.status !== "queued") continue;
    job.running = run(job);
    running += 1;
  }
}

const placeKey = (place: StoragePlace) =>
  "parentId" in place ? `folder:${place.parentId}` : `space:${place.space}`;

/**
 * Queues `files` for `target`: a place, through a shared link's door when `shareId` is set, or
 * with `replaces` a new version of that file. Given a `Picked` (a dropped or picked folder), its
 * folders are made under the place first, each file going into its own. `onFailed` is told why
 * files did not make it, once for each cause.
 */
export function addUploads(
  client: QueryClient,
  files: File[] | Picked,
  target: UploadTarget,
  onFailed: (name: string, error: unknown) => void,
) {
  const picked: Picked = Array.isArray(files)
    ? { files: files.map((file) => ({ file, dir: [] })), folders: [] }
    : files;
  if (!picked.files.length && !picked.folders.length) return;
  const identity = identityOf(client, target.shareId);
  const batch: Batch = {
    client,
    target,
    identity,
    onFailed,
    checks: identityChecks(client, target.shareId, identity, new AbortController().signal),
    folders: null,
    pending: 0,
    touched: [],
    landed: [],
    changed: false,
    told: new Set(),
  };
  if (picked.folders.length) {
    batch.folders = new FolderMaker(target.place, target.shareId, slots, (node) => {
      storageFolderMade(client, node);
      uploaded(batch, node);
    });
    makeEmptyFolders(batch, picked);
  }
  const scope =
    identity === null
      ? undefined
      : `${identity}|${placeKey(target.place)}|${target.replaces ?? ""}`;
  for (const { file, dir } of picked.files) {
    jobs.push({
      id: nextId++,
      name: file.name,
      size: file.size,
      sent: 0,
      status: "queued",
      file,
      dir,
      batch,
      resume: scope && !dir.length ? resumeKey(scope, file) : undefined,
    });
  }
  publish();
  pump();
}

function makeEmptyFolders(batch: Batch, picked: Picked) {
  const folders = batch.folders;
  if (!folders) return;
  const used = new Set<string>();
  for (const { dir } of picked.files) {
    for (let depth = 1; depth <= dir.length; depth++) used.add(dir.slice(0, depth).join("/"));
  }
  const parents = new Set(picked.folders.map((dir) => dir.slice(0, -1).join("/")));
  const signal = new AbortController().signal;
  for (const dir of picked.folders) {
    const key = dir.join("/");
    if (used.has(key) || parents.has(key)) continue;
    batch.pending += 1;
    folders
      .placeFor(dir, signal)
      .catch((error: unknown) => tell(batch, dir.at(-1) ?? "", error))
      .finally(() => {
        batch.pending -= 1;
        void finish(batch);
      });
  }
}

/** Tries a failed upload again, from the parts the server already has. */
export function retryUpload(id: number) {
  const job = jobs.find((j) => j.id === id && j.status === "failed");
  if (!job) return;
  job.status = "queued";
  job.error = undefined;
  job.batch.told.clear();
  publish();
  pump();
}

function retryUnreached() {
  let any = false;
  for (const job of jobs) {
    if (job.status !== "failed" || !isTransient(job.error)) continue;
    job.status = "queued";
    job.error = undefined;
    job.batch.told.clear();
    any = true;
  }
  if (!any) return;
  publish();
  pump();
}
if (typeof window !== "undefined") window.addEventListener("online", retryUnreached);

/** Cancels an upload (or drops a failed one) and frees what it held on the server. */
export function removeUpload(id: number) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  jobs = jobs.filter((j) => j !== job);
  job.controller?.abort();
  if (job.resume) void forgetUpload(job.resume);
  const { shareId } = job.batch.target;
  if (job.uploadId)
    void abortUpload(job.uploadId, shareId).then(() => storageChanged(job.batch.client));
  publish();
  pump();
  void finish(job.batch);
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
    if (job.resume) void forgetUpload(job.resume);
  }
  await Promise.allSettled(all.map((job) => job.running));
  await Promise.allSettled(
    all.flatMap((job) =>
      job.uploadId ? [abortUpload(job.uploadId, job.batch.target.shareId)] : [],
    ),
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
