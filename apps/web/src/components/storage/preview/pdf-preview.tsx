// A PDF, drawn by pdf.js to canvases (ADR 0040): its own script never runs (no eval, no
// annotation or form layer), and it reads the file by `Range`, so a 300-page PDF opens on its
// first pages' bytes. Only pages near the screen are drawn; the rest hold their height. Box
// comments sit over each page (`pdf-marks.tsx`).
// Loaded on its own chunk with pdf.js, the first time a PDF opens.
// First: pdf.js iterates streams, which WebKit cannot without it.
import "@/lib/stream-iterator.ts";
import "react-pdf/dist/Page/TextLayer.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Document, Page, pdfjs } from "react-pdf";
// Vite's `?url`: the worker's emitted file. The lint rule reads the module, not the query. The
// legacy build, as `vite.config.ts` aliases the API: Safari lacks JS the modern one calls.
// oxlint-disable-next-line import/default
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { SkeletonBox } from "skullet/react";
import { PageMarks } from "./pdf-marks.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Stable, or react-pdf reloads the document on every render.
const OPTIONS = {
  isEvalSupported: false,
  // Fetch what the drawn pages need, not the whole file in the background.
  disableAutoFetch: true,
  rangeChunkSize: 1024 * 1024,
};

/** Page widths step by 16px, so dragging the panel's edge doesn't redraw every frame. */
const STEP = 16;
/** Pages this far off screen are drawn ahead, and dropped past it. */
const AHEAD = "1200px 0px";

export default function PdfPreview(props: { url: string; onDownload: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const width = useStageWidth(scroller);
  const [pages, setPages] = useState(0);
  const [ratio, setRatio] = useState(1.294); // US Letter until the first page says otherwise.
  const [failed, setFailed] = useState(false);
  if (failed) return <NoPreview kind="pdf" onDownload={props.onDownload} />;
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <Document
        file={props.url}
        options={OPTIONS}
        loading={<StageLoading label="Loading PDF" />}
        error={null}
        onLoadError={() => setFailed(true)}
        onLoadSuccess={async (pdf) => {
          setPages(pdf.numPages);
          const first = await pdf.getPage(1);
          const box = first.getViewport({ scale: 1 });
          setRatio(box.height / box.width);
        }}
        className="flex flex-col items-center gap-4 p-5"
      >
        {width > 0 &&
          Array.from({ length: pages }, (_, i) => (
            <LazyPage
              key={i}
              number={i + 1}
              width={width}
              height={Math.round(width * ratio)}
              root={scroller}
            />
          ))}
      </Document>
    </div>
  );
}

/** One page: a placeholder of its height until it nears the screen, then the canvas. */
function LazyPage(props: {
  number: number;
  width: number;
  height: number;
  root: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref, props.root);
  return (
    <div
      ref={ref}
      aria-label={`Page ${props.number}`}
      style={{ width: props.width, minHeight: props.height }}
      // Not clipped: a box's comment bar may reach past the page's edge. The page clips itself.
      className="relative rounded-sm border bg-background shadow-raised"
    >
      {near && (
        <Page
          className="overflow-hidden rounded-[3px]"
          pageNumber={props.number}
          width={props.width}
          renderAnnotationLayer={false}
          loading={<SkeletonBox width={props.width} height={props.height} radius={0} />}
        />
      )}
      <PageMarks page={props.number} />
    </div>
  );
}

/** The stage's inner width, in 16px steps, capped at a readable page. */
function useStageWidth(ref: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const inner = (entry?.contentRect.width ?? 0) - 40; // The document's 20px padding.
      setWidth(Math.max(STEP, Math.min(960, Math.floor(inner / STEP) * STEP)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** True while the element is within `AHEAD` of its scroller's view. */
function useNear(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      // The latest entry: a busy page gets several at once, oldest first.
      (entries) => setNear(entries.at(-1)?.isIntersecting ?? false),
      { root: root.current, rootMargin: AHEAD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root]);
  return near;
}
