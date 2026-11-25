import type { Editor } from "@tiptap/react";
import { useEffect, useState, type CSSProperties } from "react";
import { Avatar } from "@/components/ui/avatar";

const ANCHOR = "document-face-anchor";
const BLOCK = "li, p, h1, h2, h3, h4, h5, h6, pre, blockquote, th, td, [data-type='details']";
/** A face's size, in pixels. */
export const FACE = 20;
const BESIDE_HANDLE = 58;

/**
 * Where another person is in the doc, drawn as nothing in the text: an empty mark that
 * `CollaboratorFaces` finds to put their picture beside the block.
 */
export function faceAnchor(user: Record<string, unknown>) {
  const anchor = document.createElement("span");
  anchor.className = ANCHOR;
  anchor.dataset.name = typeof user.name === "string" ? user.name : "";
  anchor.dataset.image = typeof user.image === "string" ? user.image : "";
  return anchor;
}

interface Face {
  key: string;
  name: string;
  image: string;
  top: number;
  left: number;
}

/**
 * Where a face goes for the block holding `inside`, in the scroller's own coordinates: on the
 * block's first line, left of it where the block handle sits, the `nth` one there stacked further
 * left.
 */
export function faceSpot(scroller: HTMLElement, inside: Element, nth = 0) {
  const block = inside.closest(BLOCK) ?? inside;
  const box = scroller.getBoundingClientRect();
  const at = block.getBoundingClientRect();
  const line = parseFloat(getComputedStyle(block).lineHeight) || 24;
  return {
    top: at.top - box.top + scroller.scrollTop + (line - FACE) / 2,
    left: at.left - box.left + scroller.scrollLeft - BESIDE_HANDLE - nth * (FACE - 6),
  };
}

function facesIn(scroller: HTMLElement) {
  const perBlock = new Map<Element, number>();
  const perName = new Map<string, number>();
  const faces: Face[] = [];
  for (const anchor of scroller.querySelectorAll<HTMLElement>(`.${ANCHOR}`)) {
    const name = anchor.dataset.name ?? "";
    const seen = perName.get(name) ?? 0;
    perName.set(name, seen + 1);
    const block = anchor.parentElement?.closest(BLOCK) ?? anchor.parentElement;
    if (!block) continue;
    const nth = perBlock.get(block) ?? 0;
    perBlock.set(block, nth + 1);
    faces.push({
      key: `${name}-${seen}`,
      name,
      image: anchor.dataset.image ?? "",
      ...faceSpot(scroller, block, nth),
    });
  }
  return faces;
}

/**
 * The others in a live doc, each as their picture floating left of the block they are in, past
 * the block handle so both fit, sliding as they move. Several in one block stack. No caret, no
 * highlight.
 */
export function CollaboratorFaces(props: { editor: Editor; scroller: HTMLElement | null }) {
  const { editor, scroller } = props;
  const [faces, setFaces] = useState<Face[]>([]);
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setFaces(facesIn(scroller)));
    };
    editor.on("transaction", measure);
    const resized = new ResizeObserver(measure);
    resized.observe(scroller);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", measure);
      resized.disconnect();
    };
  }, [editor, scroller]);
  return (
    <div
      aria-hidden
      data-collaborator-faces
      className="pointer-events-none absolute inset-x-0 top-0"
    >
      {faces.map((face) => (
        <Avatar
          key={face.key}
          src={face.image || null}
          initials={face.name.slice(0, 1).toUpperCase()}
          alt=""
          className="absolute top-0 left-0 bg-secondary text-muted-foreground ring-2 ring-background outline-0 transition-[translate] duration-200 ease-out motion-reduce:transition-none"
          style={
            {
              "--avatar-size": `${FACE}px`,
              translate: `${face.left}px ${face.top}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
