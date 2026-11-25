import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { IconCommentAdd } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocComments } from "@/hooks/use-doc-comments.ts";
import { commentOnSelection } from "./comment-marks.ts";

const SIZE = 26;

interface Spot {
  block: HTMLElement;
  top: number;
  left: number;
}

function spotOf(scroller: HTMLElement, block: HTMLElement) {
  const page = block.parentElement;
  if (!page) return null;
  const box = scroller.getBoundingClientRect();
  const at = block.getBoundingClientRect();
  const edge = page.getBoundingClientRect().right - parseFloat(getComputedStyle(page).paddingRight);
  const line = parseFloat(getComputedStyle(block).lineHeight) || 24;
  const spot: Spot = {
    block,
    top: at.top - box.top + scroller.scrollTop + (line - SIZE) / 2,
    left: edge - box.left + scroller.scrollLeft + 8,
  };
  return spot;
}

function commentOnBlock(editor: Editor, comments: DocComments, block: HTMLElement) {
  const inside = editor.view.posAtDOM(block, 0);
  const $pos = editor.state.doc.resolve(inside);
  const depth = Math.min(1, $pos.depth);
  const from = $pos.start(depth);
  const to = $pos.end(depth);
  if (from >= to) return;
  editor.chain().setTextSelection({ from, to }).run();
  commentOnSelection(editor, comments);
}

/**
 * Comment on a block: a button opposite the block handle, at the page's right edge beside the
 * block under the pointer, that comments on the whole block.
 */
export function BlockComment(props: {
  editor: Editor;
  comments: DocComments | null;
  scroller: HTMLElement | null;
}) {
  const { editor, comments, scroller } = props;
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    if (!scroller) return;
    const move = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const block = target?.closest<HTMLElement>(".document-page > *");
      if (block && !block.classList.contains("ProseMirror-widget"))
        setSpot(spotOf(scroller, block));
    };
    const leave = () => setSpot(null);
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerleave", leave);
    return () => {
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerleave", leave);
    };
  }, [scroller]);
  if (!comments || !spot || !spot.block.textContent?.trim()) return null;
  return (
    <div className="absolute top-0 left-0" style={{ translate: `${spot.left}px ${spot.top}px` }}>
      <TooltipTrigger delay={400}>
        <Button
          intent="plain"
          size="sq-xs"
          aria-label="Comment on block"
          onPress={() => commentOnBlock(editor, comments, spot.block)}
        >
          <IconCommentAdd />
        </Button>
        <Tooltip>Comment</Tooltip>
      </TooltipTrigger>
    </div>
  );
}
