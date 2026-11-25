import type { Editor } from "@tiptap/react";
import { cn } from "cn";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCommentPlain } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { popupSurface } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocComments } from "@/hooks/use-doc-comments.ts";
import { useStorageComments } from "@/hooks/use-storage.ts";
import { threadsOf, type StorageThread } from "@/lib/storage-comments.ts";
import { CommentRow } from "../comments-panel.tsx";
import { CommentComposer } from "../preview/comment-composer.tsx";
import { threadRange } from "./doc-comments.ts";

const MARKER = 26;
const PENDING = "pending";

interface Spot {
  block: Element;
  top: number;
  left: number;
  ids: string[];
}

function blockOf(editor: Editor, id: string) {
  const range = threadRange(editor.state, id);
  if (!range) return null;
  const { node } = editor.view.domAtPos(range.from);
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(".document-page > *") ?? null;
}

function placeOf(scroller: HTMLElement, block: Element) {
  const page = block.parentElement;
  if (!page) return null;
  const box = scroller.getBoundingClientRect();
  const at = block.getBoundingClientRect();
  const edge = page.getBoundingClientRect().right - parseFloat(getComputedStyle(page).paddingRight);
  const line = parseFloat(getComputedStyle(block).lineHeight) || 24;
  return {
    top: at.top - box.top + scroller.scrollTop + (line - MARKER) / 2,
    left: edge - box.left + scroller.scrollLeft + 8,
  };
}

function spotsOf(editor: Editor, scroller: HTMLElement, ids: string[], loose: string[]) {
  const spots = new Map<Element, Spot>();
  const add = (block: Element | null, id: string) => {
    if (!block) return;
    const spot = spots.get(block);
    if (spot) return spot.ids.push(id);
    const place = placeOf(scroller, block);
    if (place) spots.set(block, { block, ...place, ids: [id] });
  };
  for (const id of ids) add(blockOf(editor, id), id);
  const first = scroller.querySelector(".document-page > *");
  for (const id of loose) add(first, id);
  return [...spots.values()];
}

function useSpots(editor: Editor, scroller: HTMLElement | null, ids: string[], loose: string[]) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const key = `${ids.join()}|${loose.join()}`;
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor.isDestroyed) setSpots(spotsOf(editor, scroller, ids, loose));
      });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, scroller, key]);
  return spots;
}

function Marker(props: { spot: Spot; open: boolean; onPress: () => void }) {
  const count = props.spot.ids.length;
  const label = count === 1 ? "1 comment" : `${count} comments`;
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-xs"
        aria-label={label}
        aria-pressed={props.open}
        className="absolute top-0 left-0 w-auto gap-1 px-1 tabular-nums"
        style={{ translate: `${props.spot.left}px ${props.spot.top}px` }}
        onPress={props.onPress}
      >
        <IconCommentPlain />
        {count > 1 && <span className="text-xs text-muted-foreground">{count}</span>}
      </Button>
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  );
}

function useDismiss(open: boolean, close: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panel.current?.contains(target)) return;
      if (target.closest(".doc-comment, [data-comment-marker], [role=menu], [role=dialog]")) return;
      latest.current();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && latest.current();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return panel;
}

function Threads(props: {
  comments: DocComments;
  spot: Spot;
  threads: StorageThread[];
  close: () => void;
}) {
  const { comments, spot } = props;
  const [replying, setReplying] = useState<string | null>(null);
  const panel = useDismiss(true, props.close);
  const door = { id: comments.nodeId, shareId: comments.shareId };
  const shown = props.threads.filter((thread) => spot.ids.includes(thread.root.id));
  const pending = comments.pending && spot.ids.includes(PENDING) ? comments.pending : null;
  if (!pending && shown.length === 0) return null;
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Comments"
      className={cn(popupSurface, "absolute top-0 left-0 z-20 w-80 max-w-none overflow-y-auto")}
      style={{
        translate: `calc(${spot.left + MARKER}px - 100%) ${spot.top + MARKER + 4}px`,
        maxHeight: "min(28rem, 60vh)",
      }}
    >
      {shown.length > 0 && (
        <ul>
          {shown.map((thread) => (
            <CommentRow
              key={thread.root.id}
              door={door}
              thread={thread}
              inline
              replying={replying === thread.root.id}
              onReplying={(on) => setReplying(on ? thread.root.id : null)}
            />
          ))}
        </ul>
      )}
      {pending && (
        <div className={cn("p-3", shown.length > 0 && "border-t")}>
          <CommentComposer
            key={JSON.stringify(pending)}
            fileId={comments.nodeId}
            shareId={comments.shareId}
            anchor={pending}
            onClose={comments.cancel}
            onSent={comments.cancel}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A doc's comments, on the page: a marker in the right margin beside each block with threads on
 * it. The marker, or a click on a marked passage, opens those threads in a popover there, to read,
 * reply and resolve; a new comment is written in the same popover.
 */
export function DocThreads(props: {
  editor: Editor;
  comments: DocComments | null;
  scroller: HTMLElement | null;
}) {
  const { editor, comments, scroller } = props;
  const data = useStorageComments(comments?.nodeId ?? "", comments?.shareId);
  const threads = useMemo(() => threadsOf(data.data?.comments ?? [], false), [data.data]);
  const ids = useMemo(() => {
    const anchored = threads.filter(({ root }) => root.anchor?.kind === "text");
    const list = anchored.map(({ root }) => root.id);
    if (comments?.pending) list.push(PENDING);
    return list;
  }, [threads, comments?.pending]);
  const loose = useMemo(
    () => threads.filter(({ root }) => root.anchor?.kind !== "text").map(({ root }) => root.id),
    [threads],
  );
  const spots = useSpots(editor, scroller, ids, loose);
  if (!comments) return null;
  const want = comments.pending ? PENDING : comments.active;
  const open = want ? spots.find((spot) => spot.ids.includes(want)) : undefined;
  return (
    <div data-comment-marker className="absolute inset-x-0 top-0">
      {spots
        .filter((spot) => spot.ids.some((id) => id !== PENDING))
        .map((spot) => (
          <Marker
            key={spot.ids.join()}
            spot={spot}
            open={spot === open}
            onPress={() =>
              spot === open
                ? comments.close()
                : comments.pick(spot.ids.find((id) => id !== PENDING)!)
            }
          />
        ))}
      {open && <Threads comments={comments} spot={open} threads={threads} close={comments.close} />}
    </div>
  );
}
