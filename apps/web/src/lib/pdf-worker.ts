import { GlobalWorkerOptions, PDFWorker } from "pdfjs-dist";
// oxlint-disable-next-line import/default
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

let worker: PDFWorker | undefined;

/**
 * The tab's one pdf.js worker, for the preview and the tiles alike. Without one, pdf.js starts a
 * worker for each document (fetching and compiling ~1 MB of script) and ends it on close, so
 * every PDF opened paid that again.
 */
export const pdfWorker = () => (worker ??= new PDFWorker());
