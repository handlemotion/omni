import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { cn } from "cn";
import type { ItemRect } from "@/hooks/use-fluid-hover-list";

const spring = { type: "spring" as const, duration: 0.08, bounce: 0 };
const exit: Transition = { duration: 0.06 };
const fade: Transition = { duration: 0.08 };
const snap: Transition = { duration: 0 };

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
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          key={session}
          aria-hidden
          data-slot="fluid-hover-highlight"
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
