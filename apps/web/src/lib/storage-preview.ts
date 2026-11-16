// A file's preview bytes (ADR 0040), read through the same download route as Download: the start
// of a text file, an image re-typed as an allow-listed raster, and grid thumbnails downscaled once
// in the browser. Object URLs live in the query cache and are revoked when it drops them.
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { THUMBNAIL_MAX_BYTES, TEXT_PREVIEW_BYTES } from "./file-kind.ts";
import { keys } from "./query-keys.ts";
import { workspaceHeaders } from "./current-workspace.ts";

/** A file as a preview reads it: where its bytes are and which version. */
export interface PreviewSource {
  url: string;
  /** The node's `updatedAt`: a new version is a new cache entry. */
  version: string;
  size: number;
}

class PreviewError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`The file answered ${status}`);
    this.name = "PreviewError";
    this.status = status;
  }
}

async function bytes(url: string, signal: AbortSignal, range?: number) {
  const response = await fetch(url, {
    signal,
    credentials: "same-origin",
    // The tab's workspace, as every API call names it (ADR 0043).
    headers: { ...workspaceHeaders(), ...(range ? { range: `bytes=0-${range - 1}` } : {}) },
  });
  if (!response.ok) throw new PreviewError(response.status);
  return response;
}

// Previews are a version's bytes: they never go stale, and a few stay cached after their panel
// closes, so stepping back to a file is instant.
const KEEP = { staleTime: Infinity, gcTime: 5 * 60_000, retry: 1 } as const;

export interface TextPreview {
  text: string;
  /** Only the file's start was read. */
  partial: boolean;
  /** NUL bytes: not text, whatever its name says. */
  binary: boolean;
}

/** The first 512 KB, as UTF-8. A cut multi-byte character at the end decodes as U+FFFD. */
export const previewTextQuery = (source: PreviewSource) =>
  queryOptions({
    queryKey: keys.storagePreview("text", source.url, source.version),
    queryFn: async ({ signal }): Promise<TextPreview> => {
      const partial = source.size > TEXT_PREVIEW_BYTES;
      const response = await bytes(source.url, signal, partial ? TEXT_PREVIEW_BYTES : undefined);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const binary = buffer.subarray(0, 8000).includes(0);
      return { text: binary ? "" : new TextDecoder().decode(buffer), partial, binary };
    },
    ...KEEP,
  });

/** The whole image as a `blob:` URL of `raster`, never the type it was uploaded with. */
export const previewImageQuery = (source: PreviewSource, raster: string) =>
  queryOptions({
    queryKey: keys.storagePreview("image", source.url, source.version),
    queryFn: async ({ signal }) => {
      const blob = await (await bytes(source.url, signal)).blob();
      return { url: URL.createObjectURL(new Blob([blob], { type: raster })) };
    },
    ...KEEP,
  });

/** What the XLSX worker is sent: the whole file, and how much of each sheet to return. */
export interface SheetsRequest {
  buffer: ArrayBuffer;
  rows: number;
  columns: number;
}

export interface PreviewSheet {
  name: string;
  /** The cells' displayed text, row by row, the first row first. */
  rows: string[][];
  /** The sheet has more rows than were read. */
  partial: boolean;
}

export type SheetsResult = { sheets: PreviewSheet[] } | { error: true };

/** Rows and columns read from each sheet: a preview, not a spreadsheet. */
const SHEET_ROWS = 500;
const SHEET_COLUMNS = 100;
/** A workbook that takes longer than this to read (a zip bomb, a huge sheet) shows no preview. */
const SHEET_TIMEOUT = 20_000;

/** Parses off the main thread, in a worker of our own origin; ended when done or abandoned. */
function readSheets(buffer: ArrayBuffer, signal: AbortSignal) {
  return new Promise<PreviewSheet[]>((done, fail) => {
    const worker = new Worker(new URL("./xlsx-worker.ts", import.meta.url), { type: "module" });
    const end = (error?: Error, sheets?: PreviewSheet[]) => {
      worker.terminate();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (sheets) done(sheets);
      else fail(error);
    };
    const abort = () => end(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(
      () => end(new Error("The workbook took too long to read")),
      SHEET_TIMEOUT,
    );
    signal.addEventListener("abort", abort);
    worker.addEventListener("message", (event: MessageEvent<SheetsResult>) =>
      "sheets" in event.data
        ? end(undefined, event.data.sheets)
        : end(new Error("Not a workbook we can read")),
    );
    worker.addEventListener("error", () => end(new Error("The workbook reader failed")));
    const request: SheetsRequest = { buffer, rows: SHEET_ROWS, columns: SHEET_COLUMNS };
    worker.postMessage(request, [buffer]);
  });
}

/** An XLSX's visible sheets, each its first rows as text. The whole file is read: it is a zip. */
export const previewSheetsQuery = (source: PreviewSource) =>
  queryOptions({
    queryKey: keys.storagePreview("sheets", source.url, source.version),
    queryFn: async ({ signal }) => {
      const buffer = await (await bytes(source.url, signal)).arrayBuffer();
      return readSheets(buffer, signal);
    },
    ...KEEP,
    retry: false,
  });

/** The grid's tiles are at most ~300px wide; this covers them on a 2x screen. */
const THUMBNAIL_WIDTH = 640;
/** Originals fetched at once for thumbnails, so a folder of photos doesn't flood the Worker. */
const THUMBNAIL_CONCURRENCY = 4;

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= THUMBNAIL_CONCURRENCY) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** Decodes at the thumbnail's width (never wider than the original) and re-encodes small. */
async function downscale(blob: Blob, raster: string): Promise<Blob> {
  const full = await createImageBitmap(new Blob([blob], { type: raster }));
  const scale = Math.min(1, THUMBNAIL_WIDTH / full.width);
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(full, 0, 0, width, height);
  full.close();
  return new Promise((done, fail) =>
    canvas.toBlob(
      (out) => (out ? done(out) : fail(new Error("encode failed"))),
      "image/webp",
      0.82,
    ),
  );
}

/** A small copy of an image for a grid tile; originals over 20 MB get none. */
export const thumbnailQuery = (source: PreviewSource, raster: string) =>
  queryOptions({
    queryKey: keys.storagePreview("thumbnail", source.url, source.version),
    queryFn: ({ signal }) =>
      slot(async () => {
        signal.throwIfAborted();
        const blob = await (await bytes(source.url, signal)).blob();
        return { url: URL.createObjectURL(await downscale(blob, raster)) };
      }),
    enabled: source.size > 0 && source.size <= THUMBNAIL_MAX_BYTES,
    // Thumbnails are small: keep a folder's worth for the session.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });

const tracked = new WeakSet<QueryClient>();

/** Revokes a preview's object URL when the cache drops it. Once per client. */
export function revokePreviewUrls(client: QueryClient) {
  if (tracked.has(client)) return;
  tracked.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "removed" || event.query.queryKey[1] !== "preview") return;
    const data = event.query.state.data as { url?: unknown } | undefined;
    if (typeof data?.url === "string") URL.revokeObjectURL(data.url);
  });
}
