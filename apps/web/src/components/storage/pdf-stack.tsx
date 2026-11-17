// A PDF card's square: its own pages as sheets on the card's surface. A portrait page lies with
// its top-left corner in from the square's and runs off the right and bottom edges; a landscape
// one (a deck) fits whole, centred. More pages stack behind the first, their top edges showing
// above it. Hovering the card lifts the stack toward the reader.
import { useRef, useState, type CSSProperties } from "react";
import { usePdfPages } from "@/hooks/use-storage-preview.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileGlyph } from "./file-glyph.tsx";

/** One sheet, in percent of the square, front first: where it sits and where hover moves it. */
interface Sheet {
  left: number;
  top: number;
  width: number;
  /** Hover's offset and scale, toward the reader. */
  lift: [x: number, y: number, scale: number];
}

/** Each sheet behind steps this far up (and, portrait, right): its edge shows above the next. */
const STEP = 6;

/** Portrait: the front sheet's corner 12% in, those behind stepping up and right. */
function portrait(count: number): Sheet[] {
  const top = 12 + STEP * (count - 1);
  return Array.from({ length: count }, (_, i) => ({
    left: 12 + STEP * i,
    top: top - STEP * i,
    width: 100,
    lift: [-4 + i, -4 - i, 1.04],
  }));
}

/** Landscape: the front sheet fits whole, 80% wide; those behind narrow and step up. */
function landscape(count: number, ratio: number): Sheet[] {
  const height = 80 * ratio;
  const top = (100 - height) / 2 + (STEP * (count - 1)) / 2;
  return Array.from({ length: count }, (_, i) => {
    const width = 80 - 8 * i;
    return { left: (100 - width) / 2, top: top - STEP * i, width, lift: [0, -3 - 2 * i, 1.03] };
  });
}

export function PdfStack(props: { node: StorageNode; url: string }) {
  // Fetched only once the card nears the screen: a mounted card off screen fetches nothing.
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const pdf = usePdfPages(
    { url: props.url, version: props.node.updatedAt, size: props.node.size },
    near,
  );
  const [shown, setShown] = useState(false);
  const urls = pdf.data ? [pdf.data.url, ...pdf.data.more] : [];
  const ratio = pdf.data?.ratio ?? 1;
  const sheets = ratio < 1 ? landscape(urls.length, ratio) : portrait(urls.length);
  return (
    <>
      <span ref={anchor} aria-hidden className="absolute inset-0" />
      {!shown && <FileGlyph kind="pdf" className="size-8 text-muted-foreground" />}
      {/* Back to front, so the first page lands on top. */}
      {urls
        .map((url, i) => (
          <img
            key={url}
            src={url}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={i === 0 ? () => setShown(true) : undefined}
            style={place(sheets[i], ratio < 1)}
            className={`absolute max-w-none origin-top-left translate-x-0 translate-y-0 border-foreground/10 transition-[opacity,translate,scale] duration-200 ease-out group-hover:translate-x-(--lift-x) group-hover:translate-y-(--lift-y) group-hover:scale-(--lift-s) motion-reduce:transition-none ${ratio < 1 ? "rounded-xs border" : "rounded-ss-sm border-s border-t"} ${shown ? "opacity-100" : "opacity-0"}`}
          />
        ))
        .toReversed()}
    </>
  );
}

function place(sheet: Sheet | undefined, whole: boolean): CSSProperties {
  if (!sheet) return {};
  return {
    left: `${sheet.left}%`,
    top: `${sheet.top}%`,
    width: `${sheet.width}%`,
    transformOrigin: whole ? "center" : undefined,
    ["--lift-x" as string]: `${sheet.lift[0]}%`,
    ["--lift-y" as string]: `${sheet.lift[1]}%`,
    ["--lift-s" as string]: String(sheet.lift[2]),
  };
}
