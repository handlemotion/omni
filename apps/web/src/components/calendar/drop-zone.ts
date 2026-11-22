import { useEffect, useState, type DragEvent } from "react";
import {
  carriesCalendarDrag,
  dragging,
  draggedLength,
  type Dragged,
  type Drop,
} from "@/lib/calendar-drag.ts";
import { HOUR_PX, SLOT_MINUTES } from "@/lib/calendar-grid.ts";

const snap = (minutes: number) => Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

/**
 * Makes an element take the calendar's drags for `day`. On the hours (`timed`) it reads the
 * minute the dragged item's top is over and shows where it will land; elsewhere the day alone.
 */
export function useDropZone(
  day: Date,
  timed: boolean,
  onDrop: ((item: Dragged, drop: Drop) => void) | undefined,
) {
  const [hover, setHover] = useState<{ from: number; length: number } | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const clear = () => {
      setOver(false);
      setHover(null);
    };
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, []);
  const minutesAt = (event: DragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const grab = dragging()?.grabMinutes ?? 0;
    return Math.max(
      0,
      Math.min(24 * 60 - SLOT_MINUTES, snap(((event.clientY - box.top) / HOUR_PX) * 60 - grab)),
    );
  };
  const handlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const current = dragging();
      if (!onDrop || !current || !carriesCalendarDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
      if (timed) {
        setHover({ from: minutesAt(event), length: draggedLength(current.item) - current.lead });
      }
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setOver(false);
      setHover(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const current = dragging();
      setOver(false);
      setHover(null);
      if (!onDrop || !current) return;
      event.preventDefault();
      onDrop(
        current.item,
        timed ? { day, minutes: minutesAt(event), lead: current.lead } : { day },
      );
    },
  };
  return { handlers, hover, over };
}
