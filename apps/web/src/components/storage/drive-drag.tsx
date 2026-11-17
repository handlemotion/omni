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

interface Grip {
  grab: { x: number; y: number };
  width: number;
  height: number;
}

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
  const pointer = useRef({ x: 0, y: 0 });
  const unfollow = useRef<(() => void) | null>(null);
  const [lift, setLift] = useState<{ grip: Grip; copy: HTMLElement } | null>(null);
  const [back, setBack] = useState(false);
  const ending = useRef<{ land: Landing | null; settle: () => void } | null>(null);
  const change = useChangeNode();
  const reduce = useReducedMotion() ?? false;

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

const foldersFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const folders = hits.filter(
    (hit) => (hit.data?.droppableContainer.data.current as DropData | undefined)?.folder,
  );
  return folders.length ? folders : hits;
};

function hitOf(collisions: Collision[] | null) {
  const container = collisions?.[0]?.data?.droppableContainer as DroppableContainer | undefined;
  const rect = container?.rect.current;
  return container && rect
    ? { id: container.id, rect, data: container.data, disabled: container.disabled }
    : null;
}

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

function nearestGap() {
  const gaps = [...document.querySelectorAll<HTMLElement>("[data-drive-gap]")];
  const rects = gaps.map((gap) => gap.getBoundingClientRect()).filter((rect) => rect.width > 0);
  return rects[0] ?? null;
}

function swallowClick() {
  window.addEventListener("click", noClick, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", noClick, { capture: true }), 0);
}

function noClick(event: MouseEvent) {
  event.stopPropagation();
  event.preventDefault();
}

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

function Remeasure(props: { aim: Aim | null }) {
  const { measureDroppableContainers } = useDndContext();
  const opened = key(props.aim);
  useEffect(() => {
    const timer = setTimeout(() => measureDroppableContainers([]), GAP_MS + 20);
    return () => clearTimeout(timer);
  }, [opened, measureDroppableContainers]);
  return null;
}

const SETTLE_MS = 240;

const PILL_HEIGHT = 32;
const PILL_MAX = 240;

function Lifted(props: {
  source: DragSource;
  copy: HTMLElement;
  grip: Grip;
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

async function settleCopy(
  args: Parameters<DropAnimationFunction>[0],
  land: Landing | null,
  reduce: boolean,
) {
  const { dragOverlay, transform, active } = args;
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
