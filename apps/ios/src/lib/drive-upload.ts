import {
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  WORKSPACE_HEADER,
  toApiError,
} from "@omni/client";
import { Directory, File, UploadType } from "expo-file-system";
import { ApiError, api, call } from "./api.ts";
import type { DrivePlace } from "./drive-actions.ts";
import { withRetries } from "./drive-upload-retry.ts";
import { partsDir } from "./drive-upload-store.ts";
import { storageHeaders, type DriveNode } from "./drive.ts";

const PART_BUDGET = 6;
const PARTS_PER_FILE = 4;
const COPY_CHUNK = 1024 * 1024;

/** A file picked on the phone: where its bytes are, and what the Worker is told about it. */
export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string | null;
}

export interface UploadRequest {
  file: PickedFile;
  place: DrivePlace;
  /** The file this becomes a new version of; absent, it becomes a file in `place`. */
  replaces?: string | undefined;
  /** An earlier try's upload, to resume from the parts the server already has. */
  resumeId?: string | undefined;
  /** The workspace the upload was queued in: every request names it, whatever the app is in. */
  workspace: string;
  signal: AbortSignal;
  /** The upload exists on the server: keep its id to resume or cancel it. */
  onOpened: (uploadId: string) => void;
  /** Bytes the server has, plus those on their way. */
  onProgress: (sentBytes: number) => void;
}

const slots = (() => {
  let free = PART_BUDGET;
  const waiting: (() => void)[] = [];
  return {
    take: (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        if (free > 0) {
          free -= 1;
          resolve();
          return;
        }
        const grant = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const at = waiting.indexOf(grant);
          if (at >= 0) waiting.splice(at, 1);
          reject(signal.reason);
        };
        waiting.push(grant);
        signal.addEventListener("abort", stop, { once: true });
      }),
    give: () => {
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    },
  };
})();

/**
 * Uploads `file` and answers the file it became: the web's `uploadFile` protocol (open, parts
 * in parallel with retries, complete). Each part is staged from a byte range of the file and sent
 * by an upload task in the system's background session, which keeps sending while the app is
 * suspended. Every call retries what is transient and waits out a lost network. Rejects with
 * `ApiError`, or the signal's reason once it aborts.
 */
export async function uploadFile(request: UploadRequest) {
  const { file, signal } = request;
  const door = uploadDoor(request.workspace, signal);
  const upload =
    (await resumable(door, request.resumeId)) ??
    (request.replaces
      ? await door.openVersion(file, request.replaces)
      : await door.open(file, request.place));
  request.onOpened(upload.id);
  signal.throwIfAborted();
  if (!upload.nodeId) await sendParts(request, door, upload);
  signal.throwIfAborted();
  const { node } = await door.complete(upload.id);
  return node satisfies DriveNode;
}

type Upload = Awaited<ReturnType<UploadDoor["get"]>>;

async function sendParts(request: UploadRequest, door: UploadDoor, upload: Upload) {
  const { file, signal } = request;
  const stored = new Map(upload.parts.map((part) => [part.partNumber, part.size]));
  const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
    (n) => !stored.has(n),
  );
  const report = () => request.onProgress([...stored.values()].reduce((sum, n) => sum + n, 0));
  report();
  const headers = {
    ...(await storageHeaders(request.workspace)),
    [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION,
  };
  const scratch = new Directory(partsDir(), upload.id);
  scratch.create({ intermediates: true, idempotent: true });
  const parts = new AbortController();
  const stop = () => parts.abort(signal.reason);
  signal.addEventListener("abort", stop);
  const sendOne = async (n: number) => {
    const start = (n - 1) * upload.partSize;
    const length = Math.min(upload.partSize, file.size - start);
    const part = new File(scratch, `part-${n}`);
    try {
      await stagePart(file.uri, start, length, part);
      await withRetries(
        () =>
          putPart(door.partUrl(upload.id, n), part, headers, parts.signal, (sent) => {
            stored.set(n, sent);
            report();
          }),
        parts.signal,
        () => {
          stored.delete(n);
          report();
        },
      );
    } finally {
      if (part.exists) part.delete();
    }
    stored.set(n, length);
    report();
  };
  const worker = async () => {
    while (missing.length) {
      await slots.take(parts.signal);
      const n = missing.shift();
      try {
        if (n !== undefined) await sendOne(n);
      } finally {
        slots.give();
      }
    }
  };
  if (signal.aborted) stop();
  const workers = Math.min(PARTS_PER_FILE, missing.length);
  const settled = await Promise.allSettled(
    Array.from({ length: workers }, () =>
      worker().catch((error: unknown) => {
        parts.abort(error);
        throw error;
      }),
    ),
  );
  signal.removeEventListener("abort", stop);
  if (scratch.exists) scratch.delete();
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw signal.aborted ? signal.reason : parts.signal.reason;
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, workspace: string) {
  await uploadDoor(workspace, new AbortController().signal)
    .abort(uploadId)
    .catch(() => {});
}

function uploadDoor(workspace: string, signal: AbortSignal) {
  const uploads = api.storage.uploads;
  const init = { headers: { [WORKSPACE_HEADER]: workspace } };
  const retried = <T>(attempt: () => Promise<T>) => withRetries(attempt, signal);
  return {
    open: (file: PickedFile, place: DrivePlace) =>
      retried(
        async () =>
          (
            await call(
              uploads.$post(
                { json: { name: file.name, size: file.size, mimeType: file.mimeType, ...place } },
                init,
              ),
            )
          ).upload,
      ),
    openVersion: (file: PickedFile, id: string) =>
      retried(
        async () =>
          (
            await call(
              api.storage.files[":id"].versions.$post(
                { param: { id }, json: { size: file.size, mimeType: file.mimeType } },
                init,
              ),
            )
          ).upload,
      ),
    get: (id: string) =>
      retried(async () => (await call(uploads[":id"].$get({ param: { id } }, init))).upload),
    partUrl: (id: string, n: number) => `${uploads[":id"].$url({ param: { id } })}/parts/${n}`,
    complete: (id: string) =>
      retried(() => call(uploads[":id"].complete.$post({ param: { id } }, init))),
    abort: (id: string) => call(uploads[":id"].$delete({ param: { id } }, init)),
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

async function stagePart(uri: string, start: number, length: number, into: File) {
  const source = new File(uri).open();
  into.create({ overwrite: true });
  const target = into.open();
  try {
    source.offset = start;
    for (let left = length; left > 0;) {
      const chunk = await source.readBytes(Math.min(COPY_CHUNK, left));
      if (!chunk.length) throw new ApiError(0, "the file is shorter than it was");
      await target.writeBytes(chunk);
      left -= chunk.length;
    }
  } finally {
    source.close();
    target.close();
  }
}

async function putPart(
  url: string,
  part: File,
  headers: Record<string, string>,
  signal: AbortSignal,
  onSent: (bytes: number) => void,
) {
  let result;
  try {
    result = await part.upload(url, {
      httpMethod: "PUT",
      uploadType: UploadType.BINARY_CONTENT,
      sessionType: "background",
      headers,
      signal,
      onProgress: ({ bytesSent }) => onSent(Math.min(bytesSent, part.size)),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(0, "the part got no answer");
  }
  if (result.status >= 200 && result.status < 300) return;
  let body: unknown = null;
  try {
    body = JSON.parse(result.body);
  } catch {
    body = null;
  }
  const { message, ...info } = toApiError(body, `part ${result.status}`);
  const wait = Number(headerOf(result.headers, "retry-after"));
  if (!info.limit && wait > 0) {
    const resetMs = Date.now() + wait * 1000;
    info.limit = { remaining: 0, reset: Math.ceil(resetMs / 1000), resetMs };
  }
  throw new ApiError(result.status, message, info);
}

const headerOf = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
