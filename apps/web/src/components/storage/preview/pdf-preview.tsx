import "@/lib/stream-iterator.ts";
import "react-pdf/dist/Page/TextLayer.css";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Document, Page } from "react-pdf";
import { SkeletonBox } from "skullet/react";
import { pdfWorker } from "@/lib/pdf-worker.ts";
import { PageMarks } from "./pdf-marks.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

const OPTIONS = {
  worker: pdfWorker(),
  isEvalSupported: false,
  disableAutoFetch: true,
  rangeChunkSize: 1024 * 1024,
};

const STEP = 16;
const AHEAD = "1200px 0px";

export default function PdfPreview(props: { url: string; onDownload?: (() => void) | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const width = useStageWidth(scroller);
  const [pages, setPages] = useState(0);
  const [ratio, setRatio] = useState(1.294);
  const [failed, setFailed] = useState(false);
  if (failed) return <NoPreview kind="pdf" onDownload={props.onDownload} />;
  return (
    <div
      ref={scroller}
      data-preview-stage
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
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
      className="relative rounded-sm border bg-background"
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

function useStageWidth(ref: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const inner = (entry?.contentRect.width ?? 0) - 40;
      setWidth(Math.max(STEP, Math.min(960, Math.floor(inner / STEP) * STEP)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function useNear(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.at(-1)?.isIntersecting ?? false),
      { root: root.current, rootMargin: AHEAD },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, root]);
  return near;
}
