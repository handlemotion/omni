import {
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  WORKSPACE_HEADER,
  toApiError,
} from "@omni/client";
import { Directory, File, Paths, UploadType } from "expo-file-system";
import { ApiError, api, call } from "./api.ts";
import type { DrivePlace } from "./drive-actions.ts";
import { storageHeaders, type DriveNode } from "./drive.ts";

const PARALLEL_PARTS = 3;
const PART_TRIES = 3;

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

/**
 * Uploads `file` and answers the file it became: the web's `uploadFile` protocol (open, parts
 * in parallel with retries, complete), each part read from disk and sent by the system's own
 * upload task. Rejects with `ApiError`, or an `AbortError`.
 */
export async function uploadFile(request: UploadRequest) {
  const { file, signal } = request;
  const door = uploadDoor(request.workspace);
  const upload =
    (await resumable(door, request.resumeId)) ??
    (request.replaces
      ? await door.openVersion(file, request.replaces)
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
    const headers = {
      ...(await storageHeaders(request.workspace)),
      [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION,
    };
    const scratch = new Directory(Paths.cache, "uploads", upload.id);
    scratch.create({ intermediates: true, idempotent: true });
    const parts = new AbortController();
    const stop = () => parts.abort();
    signal.addEventListener("abort", stop);
    const next = async () => {
      const n = missing.shift();
      if (n === undefined) return;
      const start = (n - 1) * upload.partSize;
      const length = Math.min(upload.partSize, file.size - start);
      const part = await readPart(file.uri, start, length, new File(scratch, `part-${n}`));
      try {
        await sendPart(door.partUrl(upload.id, n), part, headers, parts.signal, (sent) => {
          stored.set(n, sent);
          report();
        });
      } finally {
        if (part.exists) part.delete();
      }
      stored.set(n, length);
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
      if (scratch.exists) scratch.delete();
    }
  }
  signal.throwIfAborted();
  const { node } = await door.complete(upload.id);
  return node satisfies DriveNode;
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, workspace: string) {
  await uploadDoor(workspace)
    .abort(uploadId)
    .catch(() => {});
}

function uploadDoor(workspace: string) {
  const uploads = api.storage.uploads;
  const init = { headers: { [WORKSPACE_HEADER]: workspace } };
  return {
    open: async (file: PickedFile, place: DrivePlace) =>
      (
        await call(
          uploads.$post(
            { json: { name: file.name, size: file.size, mimeType: file.mimeType, ...place } },
            init,
          ),
        )
      ).upload,
    openVersion: async (file: PickedFile, id: string) =>
      (
        await call(
          api.storage.files[":id"].versions.$post(
            { param: { id }, json: { size: file.size, mimeType: file.mimeType } },
            init,
          ),
        )
      ).upload,
    get: async (id: string) => (await call(uploads[":id"].$get({ param: { id } }, init))).upload,
    partUrl: (id: string, n: number) => `${uploads[":id"].$url({ param: { id } })}/parts/${n}`,
    complete: (id: string) => call(uploads[":id"].complete.$post({ param: { id } }, init)),
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

async function readPart(uri: string, start: number, length: number, into: File) {
  const handle = new File(uri).open();
  try {
    handle.offset = start;
    const bytes = await handle.readBytes(length);
    into.create({ overwrite: true });
    into.write(bytes);
    return into;
  } finally {
    handle.close();
  }
}

async function sendPart(
  url: string,
  part: File,
  headers: Record<string, string>,
  signal: AbortSignal,
  onSent: (bytes: number) => void,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await putPart(url, part, headers, signal, onSent);
    } catch (error) {
      const retryable = error instanceof ApiError && (error.status === 0 || error.status >= 500);
      if (!retryable || attempt === PART_TRIES) throw error;
      onSent(0);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      signal.throwIfAborted();
    }
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
  throw new ApiError(result.status, message, info);
}
