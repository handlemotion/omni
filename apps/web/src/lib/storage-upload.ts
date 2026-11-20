import { ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION, toApiError } from "@omni/client";
import { api, ApiError, call } from "./api.ts";
import type { StorageNode, StoragePlace } from "./storage.ts";
import { workspaceHeaders } from "./current-workspace.ts";
import { online, Slots, withRetry } from "./storage-upload-net.ts";

const PARALLEL_PARTS = 6;
const TRIES = 8;
const STALL_MS = 60_000;

export interface UploadRequest {
  file: File;
  place: StoragePlace;
  /** The file this becomes a new version of (ADR 0043); absent, it becomes a file in `place`. */
  replaces?: string | undefined;
  /**
   * With `replaces`, a checked save (ADR 0043 decision 3): the file's `contentVersion` this
   * content was made from. Refused `409 version_conflict` if someone saved since.
   */
  ifContentVersion?: number | undefined;
  /** A shared link's door, for an Editor uploading into what was shared; else the member's. */
  shareId?: string | undefined;
  /** An earlier try's upload, to resume. */
  resumeId?: string | undefined;
  signal: AbortSignal;
  /** The upload exists on the server: keep its id to resume or cancel it. */
  onOpened: (uploadId: string) => void;
  /** Bytes the server has, plus those on their way. */
  onProgress: (sentBytes: number) => void;
  /**
   * Throws when the upload may no longer go out as whoever queued it (the session changed
   * workspace or account). Called before every request that would create or add to it.
   */
  guard: () => void;
  /** Like `guard`, but asks the server who the session is now: before a file is opened. */
  confirm: () => Promise<void>;
  /** The tab's budget of upload requests in flight, shared with the other files; else its own. */
  slots?: Slots | undefined;
}

/** Uploads `file` and answers the file it became. Rejects with `ApiError`, or `AbortError`. */
export async function uploadFile(request: UploadRequest) {
  const { file, signal } = request;
  const slots = request.slots ?? new Slots(PARALLEL_PARTS);
  const door = uploadDoor(request.shareId);
  const once = <T>(send: () => Promise<T>) => slots.run(send, signal);
  const retried = <T>(send: () => Promise<T>) =>
    withRetry(() => once(send), { signal, tries: TRIES });
  await request.confirm();
  await online(signal);
  const upload =
    (await retried(() => resumable(door, request.resumeId))) ??
    (await withRetry(
      () =>
        once(() =>
          request.replaces
            ? door.openVersion(file, request.replaces, request.ifContentVersion)
            : door.open(file, request.place),
        ),
      {
        signal,
        tries: TRIES,
        transient: (error) => error instanceof ApiError && error.status === 429,
      },
    ));
  request.onOpened(upload.id);
  signal.throwIfAborted();
  if (!upload.nodeId) await sendParts({ ...request, slots }, door, upload);
  signal.throwIfAborted();
  request.guard();
  const { node } = await retried(() => door.complete(upload.id, request.ifContentVersion));
  return node satisfies StorageNode;
}

type Opened = Awaited<ReturnType<UploadDoor["open"]>>;

async function sendParts(
  request: UploadRequest & { slots: Slots },
  door: UploadDoor,
  upload: Opened,
) {
  const { file, signal } = request;
  const stored = new Map(upload.parts.map((part) => [part.partNumber, part.size]));
  const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
    (n) => !stored.has(n),
  );
  const report = () => request.onProgress([...stored.values()].reduce((sum, n) => sum + n, 0));
  report();
  const parts = new AbortController();
  const stop = () => parts.abort();
  signal.addEventListener("abort", stop);
  const worker = async () => {
    for (let n = missing.shift(); n !== undefined; n = missing.shift()) {
      const start = (n - 1) * upload.partSize;
      const part = file.slice(start, Math.min(start + upload.partSize, file.size));
      const url = door.partUrl(upload.id, n);
      const onSent = (sent: number) => {
        stored.set(n, sent);
        report();
      };
      await withRetry(
        () =>
          request.slots.run(() => {
            request.guard();
            return putPart(url, part, parts.signal, onSent);
          }, parts.signal),
        { signal: parts.signal, tries: TRIES, onRetry: () => onSent(0) },
      );
      stored.set(n, part.size);
      report();
    }
  };
  try {
    if (signal.aborted) stop();
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, missing.length) }, worker));
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, shareId?: string) {
  await uploadDoor(shareId)
    .abort(uploadId)
    .catch(() => {});
}

const openBody = (file: File, place: StoragePlace) => ({
  name: file.name,
  size: file.size,
  mimeType: file.type || null,
  ...place,
});

const versionBody = (file: File, ifContentVersion: number | undefined) => ({
  size: file.size,
  mimeType: file.type || null,
  ...(ifContentVersion === undefined ? {} : { ifContentVersion }),
});

const guarded = <T extends object>(args: T, ifContentVersion: number | undefined) =>
  (ifContentVersion === undefined
    ? args
    : ({ ...args, query: { ifContentVersion: String(ifContentVersion) } } as T)) satisfies T;

function uploadDoor(shareId: string | undefined) {
  if (!shareId) {
    const uploads = api.storage.uploads;
    return {
      open: async (file: File, place: StoragePlace) =>
        (await call(uploads.$post({ json: openBody(file, place) }))).upload,
      openVersion: async (file: File, id: string, ifContentVersion?: number) =>
        (
          await call(
            api.storage.files[":id"].versions.$post({
              param: { id },
              json: versionBody(file, ifContentVersion),
            }),
          )
        ).upload,
      get: async (id: string) => (await call(uploads[":id"].$get({ param: { id } }))).upload,
      partUrl: (id: string, n: number) => `${uploads[":id"].$url({ param: { id } })}/parts/${n}`,
      complete: (id: string, ifContentVersion?: number) =>
        call(uploads[":id"].complete.$post(guarded({ param: { id } }, ifContentVersion))),
      abort: (id: string) => call(uploads[":id"].$delete({ param: { id } })),
    };
  }
  const uploads = api.storage.shared[":shareId"].uploads;
  return {
    open: async (file: File, place: StoragePlace) =>
      (await call(uploads.$post({ param: { shareId }, json: openBody(file, place) }))).upload,
    openVersion: async (file: File, id: string, ifContentVersion?: number) =>
      (
        await call(
          api.storage.shared[":shareId"].files[":id"].versions.$post({
            param: { shareId, id },
            json: versionBody(file, ifContentVersion),
          }),
        )
      ).upload,
    get: async (id: string) => (await call(uploads[":id"].$get({ param: { shareId, id } }))).upload,
    partUrl: (id: string, n: number) =>
      `${uploads[":id"].$url({ param: { shareId, id } })}/parts/${n}`,
    complete: (id: string, ifContentVersion?: number) =>
      call(uploads[":id"].complete.$post(guarded({ param: { shareId, id } }, ifContentVersion))),
    abort: (id: string) => call(uploads[":id"].$delete({ param: { shareId, id } })),
  };
}

type UploadDoor = ReturnType<typeof uploadDoor>;

async function resumable(door: UploadDoor, uploadId: string | undefined) {
  if (!uploadId) return null;
  try {
    return await door.get(uploadId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function putPart(url: string, part: Blob, signal: AbortSignal, onSent: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const watch = () => {
      clearTimeout(stalled);
      stalled = setTimeout(() => {
        timedOut = true;
        xhr.abort();
      }, STALL_MS);
    };
    const abort = () => xhr.abort();
    const settle = (run: () => void) => {
      clearTimeout(stalled);
      signal.removeEventListener("abort", abort);
      run();
    };
    xhr.open("PUT", url);
    xhr.setRequestHeader(ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION);
    for (const [name, value] of Object.entries(workspaceHeaders()))
      xhr.setRequestHeader(name, value);
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      watch();
      onSent(Math.min(event.loaded, part.size));
    });
    xhr.addEventListener("load", () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        const { message, ...info } = toApiError(xhr.response, `part ${xhr.status}`);
        const retryAfter = Number(xhr.getResponseHeader("retry-after"));
        const details = retryAfter > 0 ? { ...info.details, retryAfter } : info.details;
        reject(new ApiError(xhr.status, message, { ...info, details }));
      }),
    );
    xhr.addEventListener("error", () =>
      settle(() => reject(new ApiError(0, "the part got no answer"))),
    );
    xhr.addEventListener("abort", () =>
      settle(() =>
        reject(
          timedOut
            ? new ApiError(408, "the part stopped sending")
            : new DOMException("upload cancelled", "AbortError"),
        ),
      ),
    );
    signal.addEventListener("abort", abort);
    if (signal.aborted) return abort();
    watch();
    xhr.send(part);
  });
}
