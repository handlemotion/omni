// A PDF's first pages as small images, for its grid tile (ADR 0040). pdf.js reads the file by
// `Range`, so a 300-page PDF costs its first pages' bytes. One worker serves every tile. Loaded on
// its own chunk, the first time a PDF tile is on screen.
import { getDocument, GlobalWorkerOptions, PDFWorker } from "pdfjs-dist";
// Vite's `?url`, the legacy build as `vite.config.ts` aliases the API (see `pdf-preview.tsx`).
// oxlint-disable-next-line import/default
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

let worker: PDFWorker | undefined;

/** A PDF's first pages for its tile, and what it takes to lay them out. */
export interface PdfPages {
  /** The first page `width` pixels wide, then up to two more at half that, as WebP. */
  pages: Blob[];
  /** The first page's height over its width: under 1 is landscape. */
  ratio: number;
  /** How many pages the PDF has. */
  count: number;
}

/** The first `max` pages, drawn by pdf.js: only their bytes are read. */
export async function firstPages(
  url: string,
  width: number,
  headers: Record<string, string>,
  signal: AbortSignal,
  max = 3,
): Promise<PdfPages> {
  worker ??= new PDFWorker();
  const task = getDocument({
    url,
    httpHeaders: headers,
    worker,
    disableAutoFetch: true,
    // Without this, pdf.js streams the whole file alongside its range reads.
    disableStream: true,
    rangeChunkSize: 256 * 1024,
  });
  const abort = () => void task.destroy();
  signal.addEventListener("abort", abort);
  try {
    const pdf = await task.promise;
    const pages: Blob[] = [];
    let ratio = 1;
    for (let n = 1; n <= Math.min(max, pdf.numPages); n += 1) {
      const page = await pdf.getPage(n);
      const box = page.getViewport({ scale: 1 });
      if (n === 1) ratio = box.height / box.width;
      // The pages behind the first show only their edges: half the pixels is plenty.
      const viewport = page.getViewport({ scale: (n === 1 ? width : width / 2) / box.width });
      pages.push(await draw(page, viewport));
    }
    return { pages, ratio, count: pdf.numPages };
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>;

async function draw(page: Page, viewport: ReturnType<Page["getViewport"]>): Promise<Blob> {
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
  );
}
