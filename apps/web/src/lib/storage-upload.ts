// One file's upload (ADR 0034 decision 5), by the member's door or a shared link's: open it, send its parts (each `partSize` bytes but the
// last, a few at once), then complete it. The server lists the parts it already has, so a retry
// passes the upload's id and sends only what is missing; an upload that is gone starts over.
import { ERROR_FORMAT_HEADER, ERROR_FORMAT_VERSION, toApiError } from "@omni/client";
import { api, ApiError, call } from "./api.ts";
import type { StorageNode, StoragePlace } from "./storage.ts";

/** Parts on their way at once. */
const PARALLEL_PARTS = 3;
/** Tries per part before the upload fails (the person can still retry: it resumes). */
const PART_TRIES = 3;

export interface UploadRequest {
  file: File;
  place: StoragePlace;
  /** A shared link's door, for an Editor uploading into what was shared; else the member's. */
  shareId?: string | undefined;
  /** An earlier try's upload, to resume. */
  resumeId?: string | undefined;
  signal: AbortSignal;
  /** The upload exists on the server: keep its id to resume or cancel it. */
  onOpened: (uploadId: string) => void;
  /** Bytes the server has, plus those on their way. */
  onProgress: (sentBytes: number) => void;
}

/** Uploads `file` and answers the file it became. Rejects with `ApiError`, or `AbortError`. */
export async function uploadFile(request: UploadRequest): Promise<StorageNode> {
  const { file, signal } = request;
  const door = uploadDoor(request.shareId);
  const upload =
    (await resumable(door, request.resumeId)) ?? (await door.open(file, request.place));
  request.onOpened(upload.id);
  signal.throwIfAborted();
  if (!upload.nodeId) {
    const stored = new Map(upload.parts.map((part) => [part.partNumber, part.size]));
    const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
      (n) => !stored.has(n),
    );
    const report = () => request.onProgress([...stored.values()].reduce((sum, n) => sum + n, 0));
    report();
    // One part failing stops the others: the upload has failed, and a retry resumes it.
    const parts = new AbortController();
    const stop = () => parts.abort();
    signal.addEventListener("abort", stop);
    const next = async (): Promise<void> => {
      const n = missing.shift();
      if (n === undefined) return;
      const start = (n - 1) * upload.partSize;
      const part = file.slice(start, Math.min(start + upload.partSize, file.size));
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
  const { node } = await door.complete(upload.id);
  return node;
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, shareId?: string) {
  await uploadDoor(shareId)
    .abort(uploadId)
    .catch(() => {});
}

/** What opening an upload sends. */
const openBody = (file: File, place: StoragePlace) => ({
  name: file.name,
  size: file.size,
  mimeType: file.type || null,
  ...place,
});

/** The upload routes of the member's door, or of a shared link's (the same shapes under it). */
function uploadDoor(shareId: string | undefined) {
  if (!shareId) {
    const uploads = api.storage.uploads;
    return {
      open: async (file: File, place: StoragePlace) =>
        (await call(uploads.$post({ json: openBody(file, place) }))).upload,
      get: async (id: string) => (await call(uploads[":id"].$get({ param: { id } }))).upload,
      partUrl: (id: string, n: number) => `${uploads[":id"].$url({ param: { id } })}/parts/${n}`,
      complete: (id: string) => call(uploads[":id"].complete.$post({ param: { id } })),
      abort: (id: string) => call(uploads[":id"].$delete({ param: { id } })),
    };
  }
  const uploads = api.storage.shared[":shareId"].uploads;
  return {
    open: async (file: File, place: StoragePlace) =>
      (await call(uploads.$post({ param: { shareId }, json: openBody(file, place) }))).upload,
    get: async (id: string) => (await call(uploads[":id"].$get({ param: { shareId, id } }))).upload,
    partUrl: (id: string, n: number) =>
      `${uploads[":id"].$url({ param: { shareId, id } })}/parts/${n}`,
    complete: (id: string) => call(uploads[":id"].complete.$post({ param: { shareId, id } })),
    abort: (id: string) => call(uploads[":id"].$delete({ param: { shareId, id } })),
  };
}

type UploadDoor = ReturnType<typeof uploadDoor>;

/** The earlier upload with the parts it has, or null when it is gone (expired, aborted). */
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
      // An answer that says no (402, 404, 409...) will say it again; no answer, or a 5xx, may not.
      const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!retryable || attempt === PART_TRIES) throw error;
      onSent(0);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      signal.throwIfAborted();
    }
  }
}

/** One part's raw bytes. XMLHttpRequest, because `fetch` cannot report how much it has sent. */
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
