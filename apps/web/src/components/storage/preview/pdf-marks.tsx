// Box comments on a PDF's pages (ADR 0043 decision 4): each open thread's box drawn over its page,
// and, while the area tool is on, a layer that takes a drag (under the "+" cursor) and hands back
// the box in fractions of the page, so it holds at any zoom. The comment bar for a drawn box sits
// at the box: under it, or over it near the page's foot. The panel provides them through
// `PdfMarksContext`; the PDF renderer only places `<PageMarks>` on each page.
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfMarks {
  /** Open threads' boxes, and the one being written (`id` "draft"). */
  boxes: (PdfBox & { id: string })[];
  selected: string | null;
  /** The area tool is on: a drag on a page draws a box. */
  drawing: boolean;
  onDraw: (box: PdfBox) => void;
  /** The comment bar for the drawn box, shown at it. */
  composer?: ReactNode;
  /** Picking a box; without it the boxes only show. */
  onSelect?: ((id: string) => void) | undefined;
}

export const PdfMarksContext = createContext<PdfMarks | null>(null);

/** A drag shorter than this share of the page on either side is a click, not a box. */
const MIN = 0.01;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Over one page: its boxes, and the drawing layer while the area tool is on. */
export function PageMarks({ page }: { page: number }) {
  const marks = use(PdfMarksContext);
  if (!marks) return null;
  const boxes = marks.boxes.filter((box) => box.page === page);
  const draft = marks.composer ? boxes.find((box) => box.id === "draft") : undefined;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {boxes.map((box) => (
        <Mark
          key={box.id}
          box={box}
          selected={box.id === marks.selected}
          onSelect={
            marks.onSelect && box.id !== "draft" ? () => marks.onSelect?.(box.id) : undefined
          }
        />
      ))}
      {marks.drawing && <DrawLayer page={page} onDraw={marks.onDraw} />}
      {draft && <AtBox box={draft}>{marks.composer}</AtBox>}
    </div>
  );
}

/** One thread's box; brought into view when its thread is picked. */
function Mark(props: {
  box: PdfBox & { id: string };
  selected: boolean;
  onSelect: (() => void) | undefined;
}) {
  const { box, selected } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="comment-box"
      onClick={props.onSelect}
      style={place(box)}
      className={`absolute rounded-xs border border-primary ${props.onSelect ? "pointer-events-auto cursor-pointer" : ""} ${
        selected || box.id === "draft" ? "bg-primary/20" : "bg-primary/8"
      }`}
    />
  );
}

/** Below the box, or above it when the box is near the page's foot; kept 8px inside the page. */
function AtBox(props: { box: PdfBox; children: ReactNode }) {
  const { box } = props;
  const above = box.y + box.height > 0.75;
  return (
    <div
      style={{
        left: `clamp(8px, ${box.x * 100}%, calc(100% - min(20rem, 100% - 16px) - 8px))`,
        ...(above
          ? { bottom: `calc(${(1 - box.y) * 100}% + 8px)` }
          : { top: `calc(${(box.y + box.height) * 100}% + 8px)` }),
      }}
      className="pointer-events-auto absolute z-20 w-80 max-w-[calc(100%-16px)] rounded-[12px] shadow-(--shadow-overlay)"
    >
      {props.children}
    </div>
  );
}

const place = (box: PdfBox) => ({
  left: `${box.x * 100}%`,
  top: `${box.y * 100}%`,
  width: `${box.width * 100}%`,
  height: `${box.height * 100}%`,
});

/** Where the pointer is on the layer, in fractions of it. */
function point(event: PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

/** Takes one drag and reports its box; the box follows the pointer while it is held. */
function DrawLayer(props: { page: number; onDraw: (box: PdfBox) => void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<PdfBox | null>(null);

  const between = (a: { x: number; y: number }, b: { x: number; y: number }): PdfBox => ({
    page: props.page,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });

  return (
    <div
      className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = point(event);
        setBox(null);
      }}
      onPointerMove={(event) => {
        if (start.current) setBox(between(start.current, point(event)));
      }}
      onPointerUp={(event) => {
        const from = start.current;
        start.current = null;
        setBox(null);
        if (!from) return;
        const drawn = between(from, point(event));
        if (drawn.width >= MIN && drawn.height >= MIN) props.onDraw(drawn);
      }}
      onPointerCancel={() => {
        start.current = null;
        setBox(null);
      }}
    >
      {box && (
        <div
          style={place(box)}
          className="absolute rounded-xs border border-primary bg-primary/20"
        />
      )}
    </div>
  );
}
