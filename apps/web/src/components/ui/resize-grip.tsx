import { cn } from "cn";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";

const CLICK_TOLERANCE_PX = 2;
const KEY_STEP_PX = 16;

/**
 * The resize grip for a column the caller lays out itself: a small pill floating just left of
 * the edge of its positioned parent, shown on hover, keyboard focus and drag, resizing the column
 * on its left. Dragging calls `onResize` with the new width; a click (a press that doesn't drag)
 * calls `onReset`; the arrow keys step it by 16px.
 */
export function ResizeGrip({
  className,
  label,
  onReset,
  onResize,
  onResizingChange,
  width,
}: {
  className?: string;
  label: string;
  onReset: () => void;
  onResize: (width: number) => void;
  /** Told when a drag starts and ends, e.g. to turn off width transitions while dragging. */
  onResizingChange?: (resizing: boolean) => void;
  /** The column's current width in pixels. */
  width: () => number;
}) {
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ moved: boolean; startWidth: number; startX: number } | null>(null);
  const setDragging = (next: boolean) => {
    setResizing(next);
    onResizingChange?.(next);
  };

  return (
    <button
      type="button"
      aria-label={label}
      data-resizing={resizing || undefined}
      className={cn(
        "absolute inset-y-0 -left-4 z-10 m-0 h-auto w-5 cursor-ew-resize touch-none border-0 outline-none",
        "before:absolute before:top-1/2 before:left-1.5 before:h-8 before:w-1 before:-translate-y-1/2 before:rounded-full before:bg-muted-foreground/50 before:opacity-0 before:transition-opacity before:duration-150 before:content-[''] motion-reduce:before:transition-none",
        "hover:before:opacity-100 focus-visible:before:opacity-100 data-resizing:before:bg-muted-foreground data-resizing:before:opacity-100",
        className,
      )}
      onKeyDown={(event: KeyboardEvent) => {
        const step =
          event.key === "ArrowLeft" ? -KEY_STEP_PX : event.key === "ArrowRight" ? KEY_STEP_PX : 0;
        if (!step) return;
        event.preventDefault();
        onResize(width() + step);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { moved: false, startWidth: width(), startX: event.clientX };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        const delta = event.clientX - current.startX;
        if (Math.abs(delta) > CLICK_TOLERANCE_PX) current.moved = true;
        if (current.moved) onResize(current.startWidth + delta);
      }}
      onPointerUp={(event) => {
        if (drag.current && !drag.current.moved) onReset();
        event.currentTarget.blur();
      }}
    />
  );
}

/**
 * A column width remembered in this browser, clamped to `[min, max]`. Returns the width (`initial`
 * until the person sets one), whether they have (`isSet`), a setter that clamps and stores, and
 * `reset`, which forgets theirs and goes back to `initial`.
 */
export function useStoredWidth(key: string, initial: number, min: number, max: number) {
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );
  const [stored, setStored] = useState<number | null>(() => {
    try {
      const value = Number(localStorage.getItem(key));
      return value ? clamp(value) : null;
    } catch {
      return null;
    }
  });
  const set = useCallback(
    (value: number) => {
      const next = clamp(value);
      setStored(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {}
    },
    [clamp, key],
  );
  const reset = useCallback(() => {
    setStored(null);
    try {
      localStorage.removeItem(key);
    } catch {}
  }, [key]);
  return { width: stored ?? initial, isSet: stored !== null, set, reset };
}
