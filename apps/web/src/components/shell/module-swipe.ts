import { useEffect, useRef, type RefObject } from "react";

const SWIPE_TRAVEL_PX = 40;
const GESTURE_PAUSE_MS = 200;
const LINE_PX = 16;

interface Gesture {
  axis: "x" | "y" | null;
  travel: number;
  done: boolean;
  last: number;
}

const fresh = () =>
  ({ axis: null, travel: 0, done: false, last: -Infinity }) satisfies Gesture as Gesture;

function scrollsSideways(target: EventTarget | null, root: Element) {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    const overflow = getComputedStyle(el).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollWidth > el.clientWidth) {
      return true;
    }
  }
  return false;
}

/**
 * A two-finger sideways swipe anywhere in the sidebar around `anchor` calls `step` once per
 * gesture: +1 for a swipe to the left (the next module), -1 to the right. A gesture's first
 * movement decides its axis, so a vertical scroll that drifts sideways stays a scroll. The
 * sidebar keeps sideways swipes to itself, so the browser's swipe back and forward never fires
 * from inside it; pinch zoom (ctrl) and sideways scrollers inside the sidebar are left alone.
 */
export function useSidewaysSwipe(anchor: RefObject<Element | null>, step: (by: 1 | -1) => void) {
  const latest = useRef(step);
  latest.current = step;

  useEffect(() => {
    const root =
      anchor.current?.closest('[data-slot="sidebar"]') ??
      anchor.current?.closest('[role="dialog"]');
    if (!root) return;
    let gesture = fresh();

    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (wheel.ctrlKey) return;
      if (wheel.timeStamp - gesture.last > GESTURE_PAUSE_MS) gesture = fresh();
      gesture.last = wheel.timeStamp;
      const scale = wheel.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : 1;
      const dx = wheel.deltaX * scale;
      const dy = wheel.deltaY * scale;
      if (!gesture.axis) {
        if (dx === 0 && dy === 0) return;
        gesture.axis =
          Math.abs(dx) > Math.abs(dy) && !scrollsSideways(wheel.target, root) ? "x" : "y";
      }
      if (gesture.axis === "y") return;
      wheel.preventDefault();
      if (gesture.done) return;
      gesture.travel += dx;
      if (Math.abs(gesture.travel) < SWIPE_TRAVEL_PX) return;
      gesture.done = true;
      latest.current(gesture.travel > 0 ? 1 : -1);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [anchor]);
}
