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
import { api, call } from "./api.ts";
import type { StorageNode, StoragePlace } from "./storage.ts";
import { workspaceHeaders } from "./current-workspace.ts";
import { browserNetwork } from "./storage-upload-net.ts";

const PARALLEL_PARTS = 6;
const STALL_MS = 60_000;

interface UploadRequest extends UploadOptions {
  file: File;
  place: StoragePlace;
  /** A shared link's door, for an Editor uploading into what was shared; else the member's. */
  shareId?: string | undefined;
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
  const { file } = request;
  await request.confirm();
  const node = await runUpload({
    ...request,
    door: uploadDoor(request.shareId),
    file: { name: file.name, size: file.size, mimeType: file.type || null },
    slots: request.slots ?? new Slots(PARALLEL_PARTS),
    partsAtOnce: PARALLEL_PARTS,
    network: browserNetwork,
    part: async ({ url, start, length }) => {
      const part = file.slice(start, start + length);
      return { send: (signal, onSent) => putPart(url, part, signal, onSent) };
    },
  });
  return node satisfies StorageNode;
}

/** Frees what an unfinished upload holds (its parts, and its room against the limit). */
export async function abortUpload(uploadId: string, shareId?: string) {
  await uploadDoor(shareId)
    .abort(uploadId)
    .catch(() => {});
}

const uploadDoor = (shareId: string | undefined) => createUploadDoor(api, call, { shareId });

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
        reject(partError(xhr.status, xhr.response, xhr.getResponseHeader("retry-after")));
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
