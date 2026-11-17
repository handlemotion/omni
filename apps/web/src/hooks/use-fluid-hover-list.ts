import { useCallback, useEffect, useRef, useState } from "react";

/** A row's box in the container's padding-box coordinates. */
export interface ItemRect {
  top: number;
  height: number;
  left: number;
  width: number;
}

/** Set on the lit row (boolean attribute), for styling it and for tests. */
export const ACTIVE_ATTR = "data-fluid-hover-active";

export interface UseFluidHoverListOptions {
  /** Matches the rows inside the container. */
  itemSelector: string;
  /** Matches the row the primitive itself highlights (React Aria's `[data-focus-visible]` for
   *  keyboard focus). Without it only the pointer lights rows. */
  highlightedSelector?: string;
  /** Matches a row that stays lit when neither the pointer nor the primitive lights one (a menu
   *  trigger whose menu is open). */
  heldSelector?: string;
  /** How far, in pixels, the pointer may sit outside a row and still light it (the gaps between
   *  rows). Beyond that nothing is lit, so a header or empty space never promises a row. */
  maxDistance?: number;
}

export interface UseFluidHoverListReturn {
  /** The lit row, for styling the highlight by row. */
  activeElement: HTMLElement | null;
  /** Spread onto `FluidHoverHighlight`. */
  highlightProps: { rect: ItemRect | null; session: number; style?: { borderRadius: string } };
  /** Spread onto the container, which must be `relative`. The ref is a callback, so a container
   *  that mounts after the hook is still observed. */
  containerProps: {
    ref: (element: HTMLElement | null) => void;
    onMouseMoveCapture: (event: React.MouseEvent) => void;
    onMouseEnter: (event: React.MouseEvent) => void;
    onMouseLeave: (event: React.MouseEvent) => void;
    onClick: (event: React.MouseEvent) => void;
  };
}

const SKIP_SELECTOR =
  "[data-disabled]:not([data-disabled='false']), [aria-disabled='true'], [data-fluid-hover-skip]";

const CONTROL_SELECTOR =
  "input, textarea, select, button, a, summary, [contenteditable], [role='textbox'], [role='searchbox'], [role='button']";

const WATCHED_ATTRIBUTES = [
  "data-focus-visible",
  "data-highlighted",
  "data-selected",
  "data-disabled",
  "aria-disabled",
  "aria-expanded",
];

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const OVERLAY_SELECTOR = "[role='menu'], [role='listbox'], [role='dialog']";

function isOwn(container: HTMLElement | null, target: EventTarget | null, itemSelector: string) {
  if (!container || !(target instanceof Element) || !container.contains(target)) return false;
  const overlay = target.closest(OVERLAY_SELECTOR);
  return !overlay || overlay.contains(container) || overlay.querySelector(itemSelector) !== null;
}

function canHover() {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches;
}

const visibleBounds: (element: HTMLElement, container: HTMLElement) => Bounds | null = (
  element,
  container,
) => {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  let { left, top, right, bottom } = rect;
  for (
    let ancestor: HTMLElement | null = element.parentElement;
    ancestor;
    ancestor = ancestor === container ? null : ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = ancestor.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};

function toContainerRect(bounds: Bounds, container: HTMLElement) {
  const box = container.getBoundingClientRect();
  const scaleX = container.offsetWidth > 0 ? box.width / container.offsetWidth : 1;
  const scaleY = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1;
  return {
    left: (bounds.left - box.left) / scaleX - container.clientLeft + container.scrollLeft,
    top: (bounds.top - box.top) / scaleY - container.clientTop + container.scrollTop,
    width: (bounds.right - bounds.left) / scaleX,
    height: (bounds.bottom - bounds.top) / scaleY,
  } satisfies ItemRect;
}

function isInside(container: HTMLElement, point: { clientX: number; clientY: number }) {
  const box = container.getBoundingClientRect();
  return (
    point.clientX > box.left &&
    point.clientX < box.right &&
    point.clientY > box.top &&
    point.clientY < box.bottom
  );
}

function rowsOf(container: HTMLElement, itemSelector: string) {
  return Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
}

function contains(bounds: Bounds | null, point: { x: number; y: number }) {
  return (
    bounds !== null &&
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  );
}

const skippedRowUnder: (
  container: HTMLElement,
  itemSelector: string,
  point: { x: number; y: number },
) => HTMLElement | null = (container, itemSelector, point) => {
  return (
    rowsOf(container, itemSelector).find(
      (row) => row.matches(SKIP_SELECTOR) && contains(visibleBounds(row, container), point),
    ) ?? null
  );
};

const pickRow: (
  container: HTMLElement,
  itemSelector: string,
  point: { x: number; y: number },
  maxDistance: number,
) => HTMLElement | null = (container, itemSelector, point, maxDistance) => {
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const row of rowsOf(container, itemSelector)) {
    if (row.matches(SKIP_SELECTOR)) continue;
    const bounds = visibleBounds(row, container);
    if (!bounds) continue;
    const dx = Math.max(bounds.left - point.x, 0, point.x - bounds.right);
    const dy = Math.max(bounds.top - point.y, 0, point.y - bounds.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return bestDistance <= maxDistance ? best : null;
};

interface LitRow {
  element: HTMLElement | null;
  picked: boolean;
  rect: ItemRect | null;
  radius: string | undefined;
}

const NOTHING_LIT: LitRow = { element: null, picked: false, rect: null, radius: undefined };

function sameRect(a: ItemRect | null, b: ItemRect | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

export function useFluidHoverList({
  itemSelector,
  highlightedSelector,
  heldSelector,
  maxDistance = 2,
}: UseFluidHoverListOptions) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    containerRef.current = element;
    setContainer(element);
  }, []);
  const [lit, setLit] = useState<LitRow>(NOTHING_LIT);
  const [session, setSession] = useState(0);
  const litRef = useRef<LitRow>(NOTHING_LIT);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const blockedRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const highlightedRow = useCallback(() => {
    const container = containerRef.current;
    if (!container || !highlightedSelector) return null;
    return rowsOf(container, itemSelector).find((row) => row.matches(highlightedSelector)) ?? null;
  }, [highlightedSelector, itemSelector]);

  const refresh = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const pointer = pointerRef.current;
    const onSkipped = pointer ? skippedRowUnder(container, itemSelector, pointer) : null;
    const picked =
      pointer && !onSkipped ? pickRow(container, itemSelector, pointer, maxDistance) : null;
    const held = heldSelector
      ? (rowsOf(container, itemSelector).find((row) => row.matches(heldSelector)) ?? null)
      : null;
    const element = onSkipped ? null : pointer ? picked : (highlightedRow() ?? held);
    const bounds = element ? visibleBounds(element, container) : null;
    const next: LitRow =
      element && bounds
        ? {
            element,
            picked: picked !== null,
            rect: toContainerRect(bounds, container),
            radius: getComputedStyle(element).borderRadius,
          }
        : NOTHING_LIT;
    const previous = litRef.current;
    if (
      previous.element === next.element &&
      previous.picked === next.picked &&
      previous.radius === next.radius &&
      sameRect(previous.rect, next.rect)
    ) {
      return;
    }
    litRef.current = next;
    setLit(next);
  }, [heldSelector, highlightedRow, itemSelector, maxDistance]);

  const scheduleRefresh = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (!container) return;
    scheduleRefresh();
    const mutations = new MutationObserver((records) => {
      const keyboardMoved =
        highlightedSelector !== undefined &&
        records.some(
          (record) =>
            record.type === "attributes" &&
            record.target instanceof HTMLElement &&
            record.target.matches(highlightedSelector) &&
            record.target.matches(itemSelector),
        );
      if (keyboardMoved) {
        const row = highlightedRow();
        const pointer = pointerRef.current;
        const underPointer =
          row !== null && pointer !== null && contains(visibleBounds(row, container), pointer);
        if (row && row !== litRef.current.element && !underPointer) pointerRef.current = null;
      }
      scheduleRefresh();
    });
    mutations.observe(container, {
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
      childList: true,
      subtree: true,
    });
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleRefresh);
    resize?.observe(container);
    window.addEventListener("scroll", scheduleRefresh, { capture: true, passive: true });
    return () => {
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener("scroll", scheduleRefresh, { capture: true });
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [container, highlightedRow, highlightedSelector, itemSelector, scheduleRefresh]);

  useEffect(() => {
    if (!container) return;
    const onPointerMove = (event: PointerEvent) => {
      if (!blockedRef.current || isInside(container, event)) return;
      blockedRef.current = false;
      pointerRef.current = null;
      scheduleRefresh();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [container, scheduleRefresh]);

  useEffect(() => {
    const element = lit.element;
    element?.setAttribute(ACTIVE_ATTR, "");
    return () => element?.removeAttribute(ACTIVE_ATTR);
  }, [lit.element]);

  const onMouseMoveCapture = useCallback(
    (event: React.MouseEvent) => {
      if (!canHover()) return;
      if (!isOwn(containerRef.current, event.target, itemSelector)) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      scheduleRefresh();
    },
    [itemSelector, scheduleRefresh],
  );

  const onMouseEnter = useCallback(
    (event: React.MouseEvent) => {
      if (!canHover()) return;
      if (litRef.current.element === null) setSession((value) => value + 1);
      blockedRef.current = false;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const onMouseLeave = useCallback(
    (event: React.MouseEvent) => {
      const container = containerRef.current;
      if (container && isInside(container, event)) {
        blockedRef.current = true;
        return;
      }
      pointerRef.current = null;
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      const container = containerRef.current;
      const target = event.target as Element | null;
      if (!container || !target?.isConnected || !pointerRef.current) return;
      if (!isOwn(container, target, itemSelector)) return;
      if (target.closest(itemSelector) || target.closest(CONTROL_SELECTOR)) return;
      const { element, picked } = litRef.current;
      if (!element || !picked || element.matches(SKIP_SELECTOR)) return;
      element.click();
    },
    [itemSelector],
  );

  return {
    activeElement: lit.element,
    highlightProps: {
      rect: lit.rect,
      session,
      ...(lit.radius ? { style: { borderRadius: lit.radius } } : {}),
    },
    containerProps: { ref, onMouseMoveCapture, onMouseEnter, onMouseLeave, onClick },
  } satisfies UseFluidHoverListReturn;
}
