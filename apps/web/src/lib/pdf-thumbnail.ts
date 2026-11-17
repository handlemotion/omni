// A PDF's first page as a small image, for its grid tile (ADR 0040). pdf.js reads the file by
// `Range`, so a 300-page PDF costs its first page's bytes. One worker serves every tile. Loaded on
// its own chunk, the first time a PDF tile is on screen.
import { getDocument, GlobalWorkerOptions, PDFWorker } from "pdfjs-dist";
// Vite's `?url`, the legacy build as `vite.config.ts` aliases the API (see `pdf-preview.tsx`).
// oxlint-disable-next-line import/default
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

let worker: PDFWorker | undefined;

/** Page 1 drawn `width` pixels wide, as WebP. */
export async function firstPage(
  url: string,
  width: number,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Blob> {
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
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    return await new Promise<Blob>((done, fail) =>
      canvas.toBlob(
        (out) => (out ? done(out) : fail(new Error("encode failed"))),
        "image/webp",
        0.82,
      ),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy();
  }
}
