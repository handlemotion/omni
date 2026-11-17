// Box comments on a PDF's pages (ADR 0043 decision 4). While the area tool is on, a layer takes a
// drag (under the "+" cursor) and hands back the box in fractions of the page, so it holds at any
// zoom; the comment bar opens up and to the right of the box, or wherever it fits on the page.
// Once sent, an open thread stays on its page as its author's picture, white-ringed, pinned at the
// box's top right corner; hovering it shows the box. The panel provides them through
// `PdfMarksContext`; the PDF renderer only places `<PageMarks>` on each page.
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { pictureUrl } from "@/lib/urls.ts";

export interface PdfBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An open thread on a page: where it points, who wrote it, and what it says. */
export interface PdfPin extends PdfBox {
  id: string;
  authorName: string;
  authorImage: string | null;
  body: string;
}

export interface PdfMarks {
  pins: PdfPin[];
  /** The box being written about, with its comment bar. */
  draft: { box: PdfBox; composer: ReactNode } | null;
  selected: string | null;
  /** The area tool is on: a drag on a page draws a box. */
  drawing: boolean;
  onDraw: (box: PdfBox) => void;
  /** The stage shows no preview to draw on after all; Comment falls back to the whole file. */
  onUnshown?: (() => void) | undefined;
  /** Picking a pin; without it the pins only show. */
  onSelect?: ((id: string) => void) | undefined;
}

export const PdfMarksContext = createContext<PdfMarks | null>(null);

/** A drag shorter than this share of the page on either side is a click, not a box. */
const MIN = 0.01;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Over one page: its pins, the box being written about, and the drawing layer. */
export function PageMarks({ page }: { page: number }) {
  const marks = use(PdfMarksContext);
  if (!marks) return null;
  const draft = marks.draft?.box.page === page ? marks.draft : null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {marks.pins
        .filter((pin) => pin.page === page)
        .map((pin) => (
          <Pin
            key={pin.id}
            pin={pin}
            selected={pin.id === marks.selected}
            onSelect={marks.onSelect ? () => marks.onSelect?.(pin.id) : undefined}
          />
        ))}
      {marks.drawing && <DrawLayer page={page} onDraw={marks.onDraw} />}
      {draft && (
        <>
          <div
            data-testid="comment-draft"
            style={place(draft.box)}
            className="absolute rounded-xs border border-primary bg-primary/20"
          />
          <AtBox box={draft.box}>{draft.composer}</AtBox>
        </>
      )}
    </div>
  );
}

/** A thread's pin: its author's picture at the box's top right; hovering shows the box. */
function Pin(props: { pin: PdfPin; selected: boolean; onSelect: (() => void) | undefined }) {
  const { pin, selected } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selected]);
  return (
    <>
      {(hover || selected) && (
        <div
          aria-hidden
          style={place(pin)}
          className="absolute rounded-xs border border-primary bg-primary/8"
        />
      )}
      <TooltipTrigger delay={200}>
        <Button
          ref={ref}
          intent="plain"
          size="sq-sm"
          data-testid="comment-pin"
          aria-label={`Comment by ${pin.authorName}`}
          onPress={props.onSelect ?? (() => {})}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          // The picture's bottom left corner on the box's top right one.
          style={{ left: `${(pin.x + pin.width) * 100}%`, bottom: `${(1 - pin.y) * 100}%` }}
          className="pointer-events-auto absolute rounded-full rounded-bl-xs bg-background p-0.5 shadow-(--shadow-overlay)"
        >
          <Avatar
            size="sm"
            src={pictureUrl(pin.authorImage)}
            initials={pin.authorName.slice(0, 1).toUpperCase()}
            className="rounded-bl-xs bg-accent text-foreground outline-0 *:rounded-bl-xs"
          />
        </Button>
        <Tooltip className="max-w-64">
          <span className="font-medium">{pin.authorName}</span> {pin.body}
        </Tooltip>
      </TooltipTrigger>
    </>
  );
}

/**
 * The comment bar beside the box: up and to the right of it, moved left where the stage around
 * the page or image runs out (kept 8px inside it), and under the box when there is not room for
 * it above. Always its full width, so a small image still gets a bar to type in.
 */
function AtBox(props: { box: PdfBox; children: ReactNode }) {
  const { box } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(box.y < 0.12);
  // Moved sideways, in px, so it stays inside the stage around the page or image.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const bar = ref.current;
    const page = bar?.parentElement;
    if (!bar || !page) return;
    const stage = bar.closest<HTMLElement>("[data-preview-stage]") ?? page;
    const place = () => {
      // Over the box while the bar, as tall as it is now (it grows as the text wraps), fits
      // above it on the page; under it otherwise.
      setBelow(box.y * page.clientHeight < bar.offsetHeight + 16);
      const room = stage.getBoundingClientRect();
      const at = bar.getBoundingClientRect();
      setShift((current) => {
        const left = at.left - current;
        const over = left + at.width - (room.right - 8);
        return over > 0 ? Math.max(room.left + 8 - left, -over) : 0;
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(bar);
    observer.observe(page);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [box.x, box.y, box.width]);
  const style: CSSProperties = {
    left: `calc(${(box.x + box.width) * 100}% + 8px)`,
    transform: shift ? `translateX(${shift}px)` : undefined,
    ...(below
      ? { top: `calc(${(box.y + box.height) * 100}% + 8px)` }
      : { bottom: `calc(${(1 - box.y) * 100}% + 8px)` }),
  };
  return (
    <div
      ref={ref}
      style={style}
      className="pointer-events-auto absolute z-20 w-80 max-w-[calc(100vw-32px)] rounded-[12px] shadow-(--shadow-overlay)"
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
