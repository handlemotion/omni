import { ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION, toApiError } from "@omni/client";
import { api, ApiError, call } from "./api.ts";
import type { StorageNode, StoragePlace } from "./storage.ts";
import { workspaceHeaders } from "./current-workspace.ts";

const PARALLEL_PARTS = 3;
const PART_TRIES = 3;

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
}

/** Uploads `file` and answers the file it became. Rejects with `ApiError`, or `AbortError`. */
export async function uploadFile(request: UploadRequest) {
  const { file, signal } = request;
  const door = uploadDoor(request.shareId);
  await request.confirm();
  const upload =
    (await resumable(door, request.resumeId)) ??
    (request.replaces
      ? await door.openVersion(file, request.replaces, request.ifContentVersion)
      : await door.open(file, request.place));
  request.onOpened(upload.id);
  signal.throwIfAborted();
  if (!upload.nodeId) {
    const stored = new Map(upload.parts.map((part) => [part.partNumber, part.size]));
    const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
      (n) => !stored.has(n),
    );
    const report = () => request.onProgress([...stored.values()].reduce((sum, n) => sum + n, 0));
    report();
    const parts = new AbortController();
    const stop = () => parts.abort();
    signal.addEventListener("abort", stop);
    const next = async () => {
      const n = missing.shift();
      if (n === undefined) return;
      const start = (n - 1) * upload.partSize;
      const part = file.slice(start, Math.min(start + upload.partSize, file.size));
      request.guard();
      await sendPart(door.partUrl(upload.id, n), part, parts.signal, (sent) => {
        stored.set(n, sent);
        report();
      });
      stored.set(n, part.size);
      report();
      return next();
    };
    try {
      if (signal.aborted) stop();
      await Promise.all(Array.from({ length: PARALLEL_PARTS }, next));
    } catch (error) {
      stop();
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  signal.throwIfAborted();
  request.guard();
  const { node } = await door.complete(upload.id, request.ifContentVersion);
  return node satisfies StorageNode;
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

async function sendPart(
  url: string,
  part: Blob,
  signal: AbortSignal,
  onSent: (bytes: number) => void,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await putPart(url, part, signal, onSent);
    } catch (error) {
      const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!retryable || attempt === PART_TRIES) throw error;
      onSent(0);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      signal.throwIfAborted();
    }
  }
}

function putPart(url: string, part: Blob, signal: AbortSignal, onSent: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = (run: () => void) => {
      signal.removeEventListener("abort", abort);
      run();
    };
    xhr.open("PUT", url);
    xhr.setRequestHeader(ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION);
    for (const [name, value] of Object.entries(workspaceHeaders()))
      xhr.setRequestHeader(name, value);
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => onSent(Math.min(event.loaded, part.size)));
    xhr.addEventListener("load", () =>
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        const { message, ...info } = toApiError(xhr.response, `part ${xhr.status}`);
        reject(new ApiError(xhr.status, message, info));
      }),
    );
    xhr.addEventListener("error", () =>
      settle(() => reject(new ApiError(0, "the part got no answer"))),
    );
    xhr.addEventListener("abort", () =>
      settle(() => reject(new DOMException("upload cancelled", "AbortError"))),
    );
    signal.addEventListener("abort", abort);
    if (signal.aborted) return abort();
    xhr.send(part);
  });
}
