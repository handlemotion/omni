// The drag under way in Drive, for the items and lists that draw it (`drive-drag.tsx` keeps it).
import { createContext, useContext } from "react";
import type { DragSource, DropPlace } from "./node-drag.tsx";

/** Where a drop would land now: a place, and the folder drawn for it (none for a page or list). */
export interface Aim {
  to: DropPlace;
  /** The drop target that highlights: a folder's card, row or sidebar row. */
  over: string | null;
}

/**
 * The drag: what is lifted, where it would land; `dragging` while it follows the pointer,
 * `landing` while it settles where it was let go.
 */
export interface DriveDragState {
  source: DragSource | null;
  /** The item it lifted from: the same folder can be drawn on the page and in the sidebar. */
  from: string | null;
  aim: Aim | null;
  phase: "origin" | "landing" | undefined;
}

export const IDLE: DriveDragState = { source: null, from: null, aim: null, phase: undefined };

export const DriveDragContext = createContext<DriveDragState>(IDLE);

export const useDriveDrag = () => useContext(DriveDragContext);

/** How long items take to move aside for a gap, and to close one (`file-sections.tsx`). */
export const GAP_MS = 200;
