import { getDocument } from "pdfjs-dist";
import { pdfWorker } from "./pdf-worker.ts";

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
) {
  const task = getDocument({
    url,
    httpHeaders: headers,
    worker: pdfWorker(),
    disableAutoFetch: true,
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
      const viewport = page.getViewport({ scale: (n === 1 ? width : width / 2) / box.width });
      pages.push(await draw(page, viewport));
    }
    return { pages, ratio, count: pdf.numPages } satisfies PdfPages;
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>;

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
