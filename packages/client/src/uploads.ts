import { toApiError } from "@omni/contracts/errors";
import type { ClientRequestOptions } from "hono/client";
import type { Api } from "./api.ts";
import { ApiError, isNotFound, isTransient, isUnreached, type Call } from "./call.ts";

/** Where a new file lands: a space's root, a teamspace's root, or a folder. */
export type UploadPlace =
  | { space: "personal" | "shared" }
  | { teamspaceId: string }
  | { parentId: string };

/** What the Worker is told about a file before its bytes go up. */
export interface UploadFileInfo {
  name: string;
  size: number;
  mimeType: string | null;
}

export const UPLOAD_TRIES = 8;
const BASE_MS = 500;
const CAP_MS = 30_000;

const cancelled = () => new DOMException("upload cancelled", "AbortError");

/**
 * A budget of requests in flight, shared by every upload that holds it: files that upload at once
 * split it between them instead of each opening its own, so many files never flood the
 * connection or the Worker.
 */
export class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(size: number) {
    this.#free = size;
  }

  /** Runs `task` once a slot is free, and frees it when `task` settles. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal) {
    await this.#take(signal);
    try {
      return await task();
    } finally {
      this.#give();
    }
  }

  #take(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const turn = () => {
        signal?.removeEventListener("abort", quit);
        resolve();
      };
      const quit = () => {
        const at = this.#waiting.indexOf(turn);
        if (at >= 0) this.#waiting.splice(at, 1);
        reject(signal?.reason ?? cancelled());
      };
      signal?.addEventListener("abort", quit, { once: true });
      this.#waiting.push(turn);
    });
  }

  #give() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/** How the platform tells whether it has a network. */
export interface UploadNetwork {
  /** Resolves once the device has a network (at once if it has one); rejects when `signal` aborts. */
  online(signal: AbortSignal): Promise<void>;
  /** Whether the device knows it is offline right now. */
  offline(): boolean | Promise<boolean>;
}

function askedWaitMs(error: unknown, now: number) {
  return error instanceof ApiError && error.retryAt ? Math.max(0, error.retryAt - now) : 0;
}

/**
 * How long to wait before try `attempt + 1`: full jitter over an exponential ceiling, so many
 * parts that failed together don't come back together. A rate limit's reset is a floor.
 */
export function backoffMs(attempt: number, error?: unknown, now = Date.now()) {
  const jitter = Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt);
  return Math.max(jitter, askedWaitMs(error, now));
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", quit);
      resolve();
    }
    function quit() {
      clearTimeout(timer);
      reject(signal?.reason ?? cancelled());
    }
    signal?.addEventListener("abort", quit, { once: true });
  });
}

export interface RetryOptions {
  signal: AbortSignal;
  network: UploadNetwork;
  tries?: number;
  transient?: (error: unknown) => boolean;
  /** Runs before each wait (a part resets its progress there). */
  onRetry?: () => void;
}

/**
 * Runs `send` until it succeeds, a failure is not `transient`, or `tries` transient failures in
 * a row. Time spent offline doesn't count as a try: it waits for the network to come back.
 */
export async function withRetry<T>(send: () => Promise<T>, options: RetryOptions) {
  const { signal, network, tries = UPLOAD_TRIES, transient = isTransient } = options;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    await network.online(signal);
    try {
      return await send();
    } catch (error) {
      if (signal.aborted || !transient(error)) throw error;
      options.onRetry?.();
      if (isUnreached(error) && (await network.offline())) {
        attempt -= 1;
        continue;
      }
      if (attempt >= tries) throw error;
      await sleep(backoffMs(attempt, error), signal);
    }
  }
}

/** A 429: the only failure opening an upload may retry. */
export const isRateLimited = (error: unknown) => error instanceof ApiError && error.status === 429;

/**
 * The `ApiError` for a part the Worker refused, from its status, its body and its `Retry-After`
 * header (a 429 without a `limit` in the body waits that long).
 */
export function partError(status: number, body: unknown, retryAfter?: string | null) {
  const { message, ...info } = toApiError(body, `part ${status}`);
  const wait = Number(retryAfter);
  if (!info.limit && wait > 0) {
    const resetMs = Date.now() + wait * 1000;
    info.limit = { remaining: 0, reset: Math.ceil(resetMs / 1000), resetMs };
  }
  return new ApiError(status, message, info);
}

const openBody = (file: UploadFileInfo, place: UploadPlace) => ({
  name: file.name,
  size: file.size,
  mimeType: file.mimeType,
  ...place,
});

const versionBody = (file: UploadFileInfo, ifContentVersion: number | undefined) => ({
  size: file.size,
  mimeType: file.mimeType,
  ...(ifContentVersion === undefined ? {} : { ifContentVersion }),
});

const guarded = <T extends object>(args: T, ifContentVersion: number | undefined) =>
  (ifContentVersion === undefined
    ? args
    : ({ ...args, query: { ifContentVersion: String(ifContentVersion) } } as T)) satisfies T;

export interface UploadDoorOptions {
  /** A shared link's door, for an Editor uploading into what was shared; else the member's. */
  shareId?: string | undefined;
  /** Options for every request, e.g. headers naming the workspace. */
  request?: ClientRequestOptions | undefined;
}

/**
 * The upload routes, through the member's door or a shared link's. A new version sends
 * `ifContentVersion` when opened and completed: the Worker refuses it `409 version_conflict` if
 * someone saved since.
 */
export function createUploadDoor(api: Api, call: Call, options: UploadDoorOptions = {}) {
  const { shareId, request: init } = options;
  if (!shareId) {
    const uploads = api.storage.uploads;
    return {
      open: async (file: UploadFileInfo, place: UploadPlace) =>
        (await call(uploads.$post({ json: openBody(file, place) }, init))).upload,
      openVersion: async (file: UploadFileInfo, id: string, ifContentVersion?: number) =>
        (
          await call(
            api.storage.files[":id"].versions.$post(
              { param: { id }, json: versionBody(file, ifContentVersion) },
              init,
            ),
          )
        ).upload,
      get: async (id: string) => (await call(uploads[":id"].$get({ param: { id } }, init))).upload,
      partUrl: (id: string, n: number) => `${uploads[":id"].$url({ param: { id } })}/parts/${n}`,
      complete: (id: string, ifContentVersion?: number) =>
        call(uploads[":id"].complete.$post(guarded({ param: { id } }, ifContentVersion), init)),
      abort: (id: string) => call(uploads[":id"].$delete({ param: { id } }, init)),
    };
  }
  const uploads = api.storage.shared[":shareId"].uploads;
  return {
    open: async (file: UploadFileInfo, place: UploadPlace) =>
      (await call(uploads.$post({ param: { shareId }, json: openBody(file, place) }, init))).upload,
    openVersion: async (file: UploadFileInfo, id: string, ifContentVersion?: number) =>
      (
        await call(
          api.storage.shared[":shareId"].files[":id"].versions.$post(
            { param: { shareId, id }, json: versionBody(file, ifContentVersion) },
            init,
          ),
        )
      ).upload,
    get: async (id: string) =>
      (await call(uploads[":id"].$get({ param: { shareId, id } }, init))).upload,
    partUrl: (id: string, n: number) =>
      `${uploads[":id"].$url({ param: { shareId, id } })}/parts/${n}`,
    complete: (id: string, ifContentVersion?: number) =>
      call(
        uploads[":id"].complete.$post(guarded({ param: { shareId, id } }, ifContentVersion), init),
      ),
    abort: (id: string) => call(uploads[":id"].$delete({ param: { shareId, id } }, init)),
  };
}

export type UploadDoor = ReturnType<typeof createUploadDoor>;
export type OpenedUpload = Awaited<ReturnType<UploadDoor["get"]>>;

/** One part, ready to go: the platform reads its bytes and sends them. */
export interface UploadPart {
  /** Sends the part once; `onSent` reports bytes on their way. Rejects with `ApiError`. */
  send(signal: AbortSignal, onSent: (bytes: number) => void): Promise<void>;
  /** Frees what readying the part took. */
  dispose?(): void;
}

/** What a caller says about one upload, whatever platform sends it. */
export interface UploadOptions {
  /** The file this becomes a new version of; absent, it becomes a file in `place`. */
  replaces?: string | undefined;
  /**
   * With `replaces`, a checked save: the file's `contentVersion` this content was made from.
   * Refused `409 version_conflict` if someone saved since.
   */
  ifContentVersion?: number | undefined;
  /** An earlier try's upload, to resume from the parts the server already has. */
  resumeId?: string | undefined;
  signal: AbortSignal;
  /** The upload exists on the server: keep its id to resume or cancel it. */
  onOpened: (uploadId: string) => void;
  /** Bytes the server has, plus those on their way. */
  onProgress: (sentBytes: number) => void;
}

export interface UploadRun extends UploadOptions {
  door: UploadDoor;
  file: UploadFileInfo;
  place: UploadPlace;
  /** Throws when the upload may no longer go out: called before each part and before completing. */
  guard?: (() => void) | undefined;
  /** The budget of requests in flight; each part holds one slot until it is stored. */
  slots: Slots;
  /** How many parts of this file go at once. */
  partsAtOnce: number;
  network: UploadNetwork;
  /** Readies part `n`, bytes `start` to `start + length` of the file, to go to `url`. */
  part: (part: {
    uploadId: string;
    n: number;
    start: number;
    length: number;
    url: string;
  }) => Promise<UploadPart>;
}

/**
 * Uploads a file and answers the node it became: resume `resumeId` if the server still has it,
 * else open the upload, send the parts it lacks in parallel, then complete. Opening retries only
 * a rate limit: after a 5xx the server may already have opened it, and a retry would leave a
 * duplicate. Rejects with `ApiError`, or the signal's reason once it aborts.
 */
export async function runUpload(run: UploadRun) {
  const { door, file, signal, slots, network } = run;
  const once = <T>(send: () => Promise<T>) => slots.run(send, signal);
  const upload =
    (await withRetry(() => once(() => resumable(door, run.resumeId)), { signal, network })) ??
    (await withRetry(
      () =>
        once(() =>
          run.replaces
            ? door.openVersion(file, run.replaces, run.ifContentVersion)
            : door.open(file, run.place),
        ),
      { signal, network, transient: isRateLimited },
    ));
  run.onOpened(upload.id);
  signal.throwIfAborted();
  if (!upload.nodeId) await sendParts(run, upload);
  signal.throwIfAborted();
  run.guard?.();
  const { node } = await withRetry(
    () => once(() => door.complete(upload.id, run.ifContentVersion)),
    {
      signal,
      network,
    },
  );
  return node;
}

async function resumable(door: UploadDoor, uploadId: string | undefined) {
  if (!uploadId) return null;
  try {
    return await door.get(uploadId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function sendParts(run: UploadRun, upload: OpenedUpload) {
  const { door, file, signal, slots, network } = run;
  const stored = new Map(upload.parts.map((part) => [part.partNumber, part.size]));
  const missing = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
    (n) => !stored.has(n),
  );
  const report = () => run.onProgress([...stored.values()].reduce((sum, n) => sum + n, 0));
  report();
  const parts = new AbortController();
  const stop = () => parts.abort(signal.reason);
  signal.addEventListener("abort", stop);
  const sendOne = async (n: number) => {
    const start = (n - 1) * upload.partSize;
    const length = Math.min(upload.partSize, file.size - start);
    const onSent = (sent: number) => {
      stored.set(n, sent);
      report();
    };
    const part = await run.part({
      uploadId: upload.id,
      n,
      start,
      length,
      url: door.partUrl(upload.id, n),
    });
    try {
      await withRetry(
        () => {
          run.guard?.();
          return part.send(parts.signal, onSent);
        },
        { signal: parts.signal, network, onRetry: () => onSent(0) },
      );
    } finally {
      part.dispose?.();
    }
    stored.set(n, length);
    report();
  };
  const worker = async () => {
    for (let n = missing.shift(); n !== undefined; n = missing.shift()) {
      const next = n;
      await slots.run(() => sendOne(next), parts.signal);
    }
  };
  if (signal.aborted) stop();
  await Promise.allSettled(
    Array.from({ length: Math.min(run.partsAtOnce, missing.length) }, () =>
      worker().catch((error: unknown) => {
        if (!parts.signal.aborted) parts.abort(error);
      }),
    ),
  );
  signal.removeEventListener("abort", stop);
  if (parts.signal.aborted) throw signal.aborted ? signal.reason : parts.signal.reason;
}
