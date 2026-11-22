import { useEffect, useRef, type RefObject } from "react";

const THRESHOLD = 40;
const QUIET_MS = 350;
const SETTLE_MS = 500;

/**
 * Turns one wheel or trackpad gesture along `axis` over `target` into a single step: +1 for down
 * or a swipe to the left (the content moves on), -1 for up or right. The gesture's momentum
 * doesn't step again: the next step needs a pause first. Wheel along the other axis, and a zoom
 * (Ctrl+wheel, a pinch), are left alone.
 */
export function useWheelStep(
  target: RefObject<HTMLElement | null>,
  axis: "x" | "y",
  onStep: (delta: 1 | -1) => void,
  enabled = true,
) {
  const step = useRef(onStep);
  useEffect(() => {
    step.current = onStep;
  });
  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;
    let sum = 0;
    let spent = false;
    let last = Number.NEGATIVE_INFINITY;
    let stepped = Number.NEGATIVE_INFINITY;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const along = axis === "x" ? event.deltaX : event.deltaY;
      const across = axis === "x" ? event.deltaY : event.deltaX;
      if (Math.abs(along) <= Math.abs(across)) return;
      event.preventDefault();
      if (event.timeStamp - last > QUIET_MS && event.timeStamp - stepped > SETTLE_MS) {
        sum = 0;
        spent = false;
      }
      last = event.timeStamp;
      if (spent) return;
      sum += along;
      if (Math.abs(sum) < THRESHOLD) return;
      spent = true;
      stepped = event.timeStamp;
      step.current(sum > 0 ? 1 : -1);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [target, axis, enabled]);
}
