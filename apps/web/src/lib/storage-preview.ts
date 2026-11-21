import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { fileType, TEXT_PREVIEW_BYTES } from "./file-kind.ts";
import type { StorageNode } from "./storage.ts";
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
    headers: { ...workspaceHeaders(), ...(range ? { range: `bytes=0-${range - 1}` } : {}) },
  });
  if (!response.ok) throw new PreviewError(response.status);
  return response;
}

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
    queryFn: async ({ signal }) => {
      const partial = source.size > TEXT_PREVIEW_BYTES;
      const response = await bytes(source.url, signal, partial ? TEXT_PREVIEW_BYTES : undefined);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const binary = buffer.subarray(0, 8000).includes(0);
      return {
        text: binary ? "" : new TextDecoder().decode(buffer),
        partial,
        binary,
      } satisfies TextPreview;
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

const SHEET_ROWS = 500;
const SHEET_COLUMNS = 100;
const SHEET_TIMEOUT = 20_000;

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

const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_CONCURRENCY = 4;

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>) {
  if (running >= THUMBNAIL_CONCURRENCY) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * A PDF's tile: its first page as `url` (what a folder's stack shows), the next two as `more`,
 * and the first page's shape. pdf.js reads only those pages' bytes, so no size cap.
 */
export const pdfThumbnailQuery = (source: PreviewSource) =>
  queryOptions({
    queryKey: keys.storagePreview("pdf-thumbnail", source.url, source.version),
    queryFn: ({ signal }) =>
      slot(async () => {
        signal.throwIfAborted();
        const { firstPages } = await import("./pdf-thumbnail.ts");
        const pdf = await firstPages(source.url, THUMBNAIL_WIDTH, workspaceHeaders(), signal);
        const [url = "", ...more] = pdf.pages.map((page) => URL.createObjectURL(page));
        return { url, more, ratio: pdf.ratio, count: pdf.count };
      }),
    enabled: source.size > 0,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });

const READ_AHEAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Starts reading what a file's preview shows, so opening it finds it in the cache: a text or CSV
 * file's first 512 KB, and with `images` an image's bytes (a list only ever reads thumbnails, so
 * originals are read ahead only beside an open file). A PDF is read by pdf.js as it draws, and a
 * workbook is read whole, so neither is read ahead.
 */
export function readAhead(
  client: QueryClient,
  node: Pick<StorageNode, "kind" | "name" | "mimeType" | "size" | "updatedAt">,
  url: string,
  images: boolean,
) {
  if (node.kind !== "file" || node.size === 0 || node.size > READ_AHEAD_MAX_BYTES) return;
  const type = fileType(node.name, node.mimeType);
  const source = { url, version: node.updatedAt, size: node.size };
  if (type.preview === "image" && type.raster) {
    if (!images) return;
    void client.prefetchQuery(previewImageQuery(source, type.raster));
  } else if ((type.preview === "text" && type.kind !== "doc") || type.preview === "csv") {
    void client.prefetchQuery(previewTextQuery(source));
  }
}

const tracked = new WeakSet<QueryClient>();

/** Revokes a preview's object URL when the cache drops it. Once per client. */
export function revokePreviewUrls(client: QueryClient) {
  if (tracked.has(client)) return;
  tracked.add(client);
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "removed" || event.query.queryKey[1] !== "preview") return;
    const data = event.query.state.data as { url?: unknown; more?: unknown } | undefined;
    if (typeof data?.url === "string") URL.revokeObjectURL(data.url);
    if (Array.isArray(data?.more)) for (const url of data.more) URL.revokeObjectURL(String(url));
  });
}
