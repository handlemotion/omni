import {
  ApiError,
  createUploadDoor,
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  partError,
  runUpload,
  Slots,
  type UploadOptions,
} from "@omni/client";
import { Directory, File, UploadType } from "expo-file-system";
import { api, call, inWorkspace, sessionHeaders } from "./api.ts";
import type { DrivePlace } from "./drive-actions.ts";
import { phoneNetwork } from "./drive-upload-retry.ts";
import { partsDir } from "./drive-upload-store.ts";
import type { DriveNode } from "./drive.ts";

const PARTS_PER_FILE = 4;
const COPY_CHUNK = 1024 * 1024;

const slots = new Slots(6);

/** A file picked on the phone: where its bytes are, and what the Worker is told about it. */
export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string | null;
}

export interface UploadRequest extends UploadOptions {
  file: PickedFile;
  place: DrivePlace;
  /** The workspace the upload was queued in: every request names it, whatever the app is in. */
  workspace: string;
}

/**
 * Uploads `file` and answers the file it became. Each part is staged from a byte range of the
 * file and sent by an upload task in the system's background session, which keeps sending while
 * the app is suspended. Rejects with `ApiError`, or the signal's reason once it aborts.
 */
export async function uploadFile(request: UploadRequest) {
  const { file } = request;
  const headers = {
    ...(await sessionHeaders(request.workspace)),
    [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION,
  };
  let scratch: Directory | undefined;
  try {
    const node = await runUpload({
      ...request,
      door: uploadDoor(request.workspace),
      slots,
      partsAtOnce: PARTS_PER_FILE,
      network: phoneNetwork,
      part: async ({ uploadId, n, start, length, url }) => {
        scratch ??= new Directory(partsDir(), uploadId);
        scratch.create({ intermediates: true, idempotent: true });
        const part = new File(scratch, `part-${n}`);
        try {
          await stagePart(file.uri, start, length, part);
        } catch (error) {
          if (part.exists) part.delete();
          throw error;
        }
        return {
          send: (signal, onSent) => putPart(url, part, headers, signal, onSent),
          dispose: () => {
            if (part.exists) part.delete();
          },
        };
      },
    });
    return node satisfies DriveNode;
  } finally {
    if (scratch?.exists) scratch.delete();
  }
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, workspace: string) {
  await uploadDoor(workspace)
    .abort(uploadId)
    .catch(() => {});
}

const uploadDoor = (workspace: string) =>
  createUploadDoor(api, call, { request: inWorkspace(workspace) });

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
  throw partError(result.status, body, headerOf(result.headers, "retry-after"));
}

const headerOf = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
