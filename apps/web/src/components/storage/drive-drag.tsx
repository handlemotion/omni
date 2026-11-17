// Drive's drags, from pickup to landing (`node-drag.tsx` says what drags and what takes drops).
//
// Pressed and moved 5px, an item lifts: a copy of it, in its own colours and rounding, rises a
// little and follows the pointer (a row narrows as it does), and where it was keeps a dashed edge.
// Held over a folder, the folder highlights; held over a page or a list that would take it beside
// its siblings, they move aside to open a gap where it will land, in the Worker's order. Let go,
// the copy settles: into the gap, into the folder (shrinking away), or back where it came from;
// then the move is made, and the lists' caches show it at once (`storage-cache.ts`).
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimationFunction,
  type Collision,
  type DroppableContainer,
  type Over,
} from "@dnd-kit/core";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useChangeNode } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import {
  DriveDragContext,
  GAP_MS,
  IDLE,
  type Aim,
  type DriveDragState,
} from "./drive-drag-state.ts";
import { canMove, type DragSource, type DropData, type Look } from "./node-drag.tsx";
import { FileTile } from "./file-glyph.tsx";
import { storageErrorToast } from "./storage-errors.ts";

/** Where the pointer took hold of the item, and the item's size then. */
interface Grip {
  /** The pointer's offset into the item. */
  grab: { x: number; y: number };
  width: number;
  height: number;
}

/** Where a drop settles: into a folder (the copy shrinks into it) or a gap (it fills it). */
interface Landing {
  aim: Aim;
  rect: ClientRect | null;
  into: boolean;
}

export function DriveDragProvider({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [state, setState] = useState<DriveDragState>(IDLE);
  const live = useRef(state);
  const update = (next: DriveDragState) => {
    live.current = next;
    setState(next);
  };
  const grip = useRef<Grip | null>(null);
  // Where the pointer is now. dnd-kit's delta counts scrolling too, so it would put the pointer
  // off by however far the page or sidebar scrolled under it.
  const pointer = useRef({ x: 0, y: 0 });
  const unfollow = useRef<(() => void) | null>(null);
  const [lift, setLift] = useState<{ grip: Grip; copy: HTMLElement } | null>(null);
  const [back, setBack] = useState(false);
  const ending = useRef<{ land: Landing | null; settle: () => void } | null>(null);
  const change = useChangeNode();
  const reduce = useReducedMotion() ?? false;

  /** Keeps `pointer` where the pointer is, ahead of dnd-kit's own listener, until the drag ends. */
  const track = (event: PointerEvent) => {
    pointer.current = { x: event.clientX, y: event.clientY };
  };
  const follow = () => {
    unfollow.current?.();
    window.addEventListener("pointermove", track, { capture: true });
    unfollow.current = () => window.removeEventListener("pointermove", track, { capture: true });
  };

  const onDragStart = (event: DragStartEvent) => {
    const source = event.active.data.current as DragSource | undefined;
    const down = event.activatorEvent as PointerEvent;
    const element = (down.target as Element | null)?.closest<HTMLElement>("[data-drive-drag]");
    if (!source || !element) return;
    const box = element.getBoundingClientRect();
    grip.current = {
      grab: { x: down.clientX - box.left, y: down.clientY - box.top },
      width: box.width,
      height: box.height,
    };
    pointer.current = { x: down.clientX, y: down.clientY };
    follow();
    setLift({ grip: grip.current, copy: liftedCopy(element, source.look) });
    update({ source, from: String(event.active.id), aim: null, phase: "origin" });
  };

  // Only the pointer moves the aim: a gap opening shifts the targets under a still pointer, and
  // following that would close the gap again, and open it, without end.
  const onDragMove = (event: DragMoveEvent) => {
    const { source, aim } = live.current;
    if (!source) return;
    const next = aimAt(hitOf(event.collisions), pointer.current, source);
    if (next?.over === aim?.over && sameAim(next, aim)) return;
    update({ ...live.current, aim: next });
  };

  const onDragEnd = (_event: DragEndEvent) => {
    const { source, aim } = live.current;
    swallowClick();
    if (!source || !aim) {
      end(null);
      return;
    }
    const rect = aim.over
      ? ((
          document.querySelector("[data-drive-target] [data-slot=folder-art]") ??
          document.querySelector("[data-drive-target]")
        )?.getBoundingClientRect() ?? null)
      : nearestGap();
    end({ aim, rect, into: aim.over !== null });
  };

  const onDragCancel = () => end(null);

  /**
   * Let go: the copy settles (`dropAnimation`), then the move is made and the drag is over. Once
   * only, and in time even when the copy has nothing to settle onto; a drag picked up meanwhile
   * keeps its own state.
   */
  const end = (land: Landing | null) => {
    const { source } = live.current;
    unfollow.current?.();
    unfollow.current = null;
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      if (source && land) move(source, land.aim);
      if (live.current.source === source) update(IDLE);
    };
    ending.current = { land, settle };
    setBack(!land);
    setTimeout(settle, SETTLE_MS * 3);
    update({ ...live.current, aim: land ? live.current.aim : null, phase: "landing" });
  };

  const move = (source: DragSource, aim: Aim) => {
    const { node, shareId } = source;
    change
      .mutateAsync({ id: node.id, place: aim.to.place, ...(shareId ? { shareId } : {}) })
      .catch((error: unknown) => storageErrorToast(error, `“${node.name}” was not moved`));
  };

  const dropAnimation: DropAnimationFunction = (args) => {
    const finished = ending.current;
    return settleCopy(args, finished?.land ?? null, reduce).then(() => finished?.settle());
  };

  return (
    <DriveDragContext value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={foldersFirst}
        autoScroll={{ threshold: { x: 0, y: 0.15 } }}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {children}
        <Remeasure aim={state.aim} />
        <NoNativeDrags />
        {state.phase === "origin" && <style>{"*{cursor:grabbing!important}"}</style>}
        {/* On the body: a transformed ancestor would carry the fixed-position copy away. */}
        {createPortal(
          <DragOverlay dropAnimation={dropAnimation} zIndex={60} className="pointer-events-none">
            {state.source && lift ? (
              <Lifted
                source={state.source}
                copy={lift.copy}
                grip={lift.grip}
                back={state.phase === "landing" && back}
                reduce={reduce}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </DriveDragContext>
  );
}

/** The drop targets under the pointer, folders before the pages and lists they sit in. */
const foldersFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const folders = hits.filter(
    (hit) => (hit.data?.droppableContainer.data.current as DropData | undefined)?.folder,
  );
  return folders.length ? folders : hits;
};

/** The drop target under the pointer now (a move's `over` is the one under it a move ago). */
function hitOf(collisions: Collision[] | null) {
  const container = collisions?.[0]?.data?.droppableContainer as DroppableContainer | undefined;
  const rect = container?.rect.current;
  return container && rect
    ? { id: container.id, rect, data: container.data, disabled: container.disabled }
    : null;
}

/** Where a drop at `pointer` over `over` would land, if `source` can move there. */
function aimAt(over: Over | null, pointer: { x: number; y: number }, source: DragSource) {
  const data = over?.data.current as DropData | undefined;
  if (!over || !data) return null;
  const { top, height } = over.rect;
  const edge = (pointer.y - top) / height;
  const beside = data.beside && (edge < 0.25 || edge > 0.75);
  const aim: Aim =
    beside && data.beside
      ? { to: data.beside, over: null }
      : { to: data.to, over: data.folder ? String(over.id) : null };
  return canMove(source, aim.to) ? aim : null;
}

const key = (aim: Aim | null) =>
  aim ? `${"parentId" in aim.to.place ? aim.to.place.parentId : aim.to.place.space}` : "";
const sameAim = (a: Aim | null, b: Aim | null) => key(a) === key(b);

/** The gap opened for the drop nearest the pointer's last place, if one is drawn. */
function nearestGap() {
  const gaps = [...document.querySelectorAll<HTMLElement>("[data-drive-gap]")];
  const rects = gaps.map((gap) => gap.getBoundingClientRect()).filter((rect) => rect.width > 0);
  return rects[0] ?? null;
}

/**
 * The press that ended a drag is no click: React Aria's items and links act on the click that
 * follows a pointer up, which would open what was just dropped.
 */
function swallowClick() {
  window.addEventListener("click", noClick, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", noClick, { capture: true }), 0);
}

function noClick(event: MouseEvent) {
  event.stopPropagation();
  event.preventDefault();
}

/**
 * The browser's own drags stay off our items: a sidebar row's link would drag its address, a
 * thumbnail its image, and either would take the pointer away from the drag.
 */
function NoNativeDrags() {
  useEffect(() => {
    document.addEventListener("dragstart", noNativeDrag);
    return () => document.removeEventListener("dragstart", noNativeDrag);
  }, []);
  return null;
}

function noNativeDrag(event: DragEvent) {
  if ((event.target as Element | null)?.closest?.("[data-drive-drag]")) event.preventDefault();
}

/**
 * Measures the drop targets again once a gap has opened or closed and the items around it have
 * moved: a target is found by where it was measured.
 */
function Remeasure(props: { aim: Aim | null }) {
  const { measureDroppableContainers } = useDndContext();
  const opened = key(props.aim);
  useEffect(() => {
    const timer = setTimeout(() => measureDroppableContainers([]), GAP_MS + 20);
    return () => clearTimeout(timer);
  }, [opened, measureDroppableContainers]);
  return null;
}

/** How long the lifted copy takes to settle where it was let go. */
const SETTLE_MS = 240;

/** The pill everything lifts into: its height, and how wide its name may make it. */
const PILL_HEIGHT = 32;
const PILL_MAX = 240;

/**
 * What follows the pointer: the item itself as it is picked up, settling at once into one compact
 * pill (its glyph and name) whatever it was, a card, a row or a sidebar row; and back into the
 * item when it returns where it was.
 */
function Lifted(props: {
  source: DragSource;
  copy: HTMLElement;
  grip: Grip;
  /** Going back where it came from: it grows into the item again. */
  back: boolean;
  reduce: boolean;
}) {
  const { grip, back, source } = props;
  const mount = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(PILL_MAX);
  useEffect(() => {
    mount.current?.replaceChildren(props.copy);
  }, [props.copy]);
  useLayoutEffect(() => {
    if (label.current) setWidth(Math.min(PILL_MAX, label.current.scrollWidth));
  }, [source.node.name]);
  const { node } = source;
  const kind = node.kind === "folder" ? "folder" : fileType(node.name, node.mimeType).kind;
  // The pill sits with its glyph under the pointer, where the item was taken hold of.
  const pill = {
    width,
    height: PILL_HEIGHT,
    x: grip.grab.x - PILL_HEIGHT / 2,
    y: grip.grab.y - PILL_HEIGHT / 2,
    borderRadius: 10,
  };
  const item = {
    width: grip.width,
    height: grip.height,
    x: 0,
    y: 0,
    borderRadius: source.look === "card" ? 12 : 8,
  };
  const transition = props.reduce
    ? { duration: 0 }
    : { type: "spring" as const, duration: 0.32, bounce: 0.12 };
  const fade = props.reduce ? { duration: 0 } : { duration: 0.12, ease: "easeOut" as const };
  return (
    <motion.div
      data-pill
      initial={item}
      animate={back ? item : pill}
      transition={transition}
      className="relative overflow-hidden border bg-surface shadow-overlay"
    >
      <motion.div
        ref={mount}
        inert
        initial={{ opacity: 1 }}
        animate={{ opacity: back ? 1 : 0 }}
        transition={fade}
        style={{ width: grip.width, height: grip.height }}
        className="absolute start-0 top-0 *:m-0! *:size-full"
      />
      <motion.span
        ref={label}
        initial={{ opacity: 0 }}
        animate={{ opacity: back ? 0 : 1 }}
        transition={fade}
        className="absolute inset-y-0 start-0 flex w-max items-center gap-2 ps-1 pe-3 text-sm text-foreground"
      >
        <FileTile kind={kind} size="xs" />
        <span className="max-w-48 truncate">{node.name}</span>
      </motion.span>
    </motion.div>
  );
}

/**
 * A copy of the lifted item, drawn as the item is: a row without its trailing columns, and
 * canvases (a PDF's first page) with their pixels, which copying an element leaves blank.
 */
function liftedCopy(element: HTMLElement, look: Look) {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const trim of copy.querySelectorAll("[data-drag-trim]")) trim.remove();
  if (look === "tree") for (const button of copy.querySelectorAll("button")) button.remove();
  const from = element.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, i) => {
    const source = from[i];
    if (source?.width && source.height) canvas.getContext("2d")?.drawImage(source, 0, 0);
  });
  ownIds(copy);
  copy.removeAttribute("id");
  copy.removeAttribute("data-drive-target");
  return copy;
}

/**
 * The copy's ids its own: an icon's mask is found by id, and the first element with it (the item's
 * own, hidden while lifted) would mask the copy's icon away.
 */
function ownIds(copy: HTMLElement) {
  const ids = [...copy.querySelectorAll("[id]")].map((element) => element.id);
  if (!ids.length) return;
  for (const element of copy.querySelectorAll("[id]")) element.id = `${element.id}-lifted`;
  for (const element of copy.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (!attribute.value.includes("url(#")) continue;
      attribute.value = attribute.value.replace(/url\(#([^)]+)\)/g, (all, id: string) =>
        ids.includes(id) ? `url(#${id}-lifted)` : all,
      );
    }
  }
}

/**
 * The copy settles where the drop goes: into a gap's place, shrinking into a folder, or back to
 * the item it lifted from.
 */
async function settleCopy(
  args: Parameters<DropAnimationFunction>[0],
  land: Landing | null,
  reduce: boolean,
) {
  const { dragOverlay, transform, active } = args;
  // A drop moves the pill; a return moves the item it grows back into.
  const pill = land && dragOverlay.node.querySelector("[data-pill]");
  const from = pill ? pill.getBoundingClientRect() : dragOverlay.rect;
  const to = land?.rect ?? (land ? null : active.rect);
  const start = `translate3d(${transform.x}px, ${transform.y}px, 0)`;
  if (reduce || !to) {
    await dragOverlay.node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).finished;
    return;
  }
  const into = land?.into ?? false;
  const dx = into ? to.left + to.width / 2 - (from.left + from.width / 2) : to.left - from.left;
  const dy = into ? to.top + to.height / 2 - (from.top + from.height / 2) : to.top - from.top;
  const end = `translate3d(${transform.x + dx}px, ${transform.y + dy}px, 0)${into ? " scale(0.3)" : ""}`;
  await dragOverlay.node.animate(
    [
      { transform: start, opacity: 1 },
      { transform: end, opacity: into ? 0 : 1 },
    ],
    {
      duration: into ? SETTLE_MS - 20 : SETTLE_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "forwards",
    },
  ).finished;
}
