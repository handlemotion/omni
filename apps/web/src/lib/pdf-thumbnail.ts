import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
// oxlint-disable-next-line import/default
import rendererUrl from "pdfjs-dist/legacy/build/pdf.renderer.min.mjs?url";
import { pdfWorker } from "./pdf-worker.ts";

/** A PDF's first page for its tile, and what it takes to lay the tile out. */
export interface FirstPage {
  /** The first page `width` pixels wide, as WebP. */
  page: Blob;
  /** The first page's height over its width: under 1 is landscape. */
  ratio: number;
  /** How many pages the PDF has. */
  count: number;
}

const KEEP_OPEN_MS = 30_000;

interface Open {
  task: ReturnType<typeof getDocument>;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
}

const documents = new Map<string, Open>();

function drawnOffThread<T>(open: () => T) {
  const before = GlobalWorkerOptions.rendererSrc;
  GlobalWorkerOptions.rendererSrc = rendererUrl;
  try {
    return open();
  } finally {
    GlobalWorkerOptions.rendererSrc = before;
  }
}

/** Where a file's bytes are, and which version: a new version is another document. */
export interface PdfSource {
  url: string;
  version: string;
}

function borrow(source: PdfSource, headers: Record<string, string>) {
  const key = `${source.version} ${source.url}`;
  let open = documents.get(key);
  if (!open) {
    const task = drawnOffThread(() =>
      getDocument({
        url: source.url,
        httpHeaders: headers,
        worker: pdfWorker(),
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 256 * 1024,
      }),
    );
    open = { task, users: 0 };
    documents.set(key, open);
    task.promise.catch(() => close(key, open!));
  }
  clearTimeout(open.timer);
  open.users += 1;
  return { open, key };
}

function close(key: string, open: Open) {
  clearTimeout(open.timer);
  if (documents.get(key) === open) documents.delete(key);
  void open.task.destroy();
}

function giveBack(key: string, open: Open, keep: boolean) {
  open.users -= 1;
  if (open.users > 0) return;
  if (!keep) return close(key, open);
  open.timer = setTimeout(() => close(key, open), KEEP_OPEN_MS);
}

async function withDocument<T>(
  source: PdfSource,
  headers: Record<string, string>,
  signal: AbortSignal,
  keep: boolean,
  work: (pdf: PDFDocumentProxy) => Promise<T>,
) {
  const { open, key } = borrow(source, headers);
  let done = false;
  const abort = () => {
    if (open.users <= 1) close(key, open);
  };
  signal.addEventListener("abort", abort);
  try {
    const result = await work(await open.task.promise);
    done = true;
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    giveBack(key, open, keep && done);
  }
}

/**
 * The first page, `width` pixels wide, drawn by pdf.js: only its bytes are read. The document
 * stays open a while for `nextPages`.
 */
export function firstPage(
  source: PdfSource,
  width: number,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  return withDocument(source, headers, signal, true, async (pdf) => {
    const page = await pdf.getPage(1);
    const box = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / box.width });
    return {
      page: await draw(page, viewport),
      ratio: box.height / box.width,
      count: pdf.numPages,
    } satisfies FirstPage;
  });
}

/** Pages 2 to `last`, each `width` pixels wide: the sheets behind a tile's first page. */
export function nextPages(
  source: PdfSource,
  width: number,
  last: number,
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  return withDocument(source, headers, signal, false, async (pdf) => {
    const pages: Blob[] = [];
    for (let n = 2; n <= Math.min(last, pdf.numPages); n += 1) {
      signal.throwIfAborted();
      const page = await pdf.getPage(n);
      const box = page.getViewport({ scale: 1 });
      pages.push(await draw(page, page.getViewport({ scale: width / box.width })));
    }
    return pages;
  });
}

type Page = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;

async function draw(page: Page, viewport: ReturnType<Page["getViewport"]>) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport, background: "#ffffff" }).promise;
  return new Promise<Blob>((done, fail) =>
    canvas.toBlob(
      (out) => (out ? done(out) : fail(new Error("encode failed"))),
      "image/webp",
      0.82,
    ),
  ) satisfies Promise<Blob>;
}
