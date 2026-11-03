// The one hover highlight a fluid hover list renders, ported from transitive
// (`packages/ui/src/components/ui/fluid-hover-highlight.tsx`): an absolutely positioned fill that
// springs between the rects `useFluidHoverList` measures. The container must be `relative`; rows
// sit over it and carry no hover fill of their own.
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { cn } from "cn";
import type { ItemRect } from "@/hooks/use-fluid-hover-list";

// Critically damped and short: the highlight lands exactly on the row, no overshoot.
const spring = { type: "spring" as const, duration: 0.08, bounce: 0 };
const exit: Transition = { duration: 0.06 };
const fade: Transition = { duration: 0.08 };
const snap: Transition = { duration: 0 };

/** A measured rect as animation targets: position as a transform, size as layout. */
function toTarget(rect: ItemRect) {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export interface FluidHoverHighlightProps {
  /** The rect to sit on, in the container's coordinate space. `null` fades it out. */
  rect: ItemRect | null;
  /** Increments when the pointer enters the list, which re-keys the highlight so it fades in on
   *  the row instead of sliding over from wherever it was last. */
  session: number;
  /** Fill, radius, z-index. Merged onto `absolute bg-hover pointer-events-none`. */
  className?: string;
  /** The lit row's border radius, read at runtime. */
  style?: { borderRadius?: string };
}

export function FluidHoverHighlight({ rect, session, className, style }: FluidHoverHighlightProps) {
  // Reduced motion keeps the fade and drops the travel: fewer and gentler, not none.
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          key={session}
          aria-hidden
          data-slot="fluid-hover-highlight"
          // Pinned to the container's corner and moved with a transform, so the travel runs on
          // the compositor instead of re-laying out every frame.
          className={cn("pointer-events-none absolute top-0 left-0 bg-hover", className)}
          style={style}
          initial={{ opacity: 0, ...toTarget(rect) }}
          animate={{ opacity: 1, ...toTarget(rect) }}
          exit={{ opacity: 0, transition: exit }}
          transition={{ ...(reduceMotion ? snap : spring), opacity: fade }}
        />
      )}
    </AnimatePresence>
  );
}
