import type { CalendarEvent } from "./calendar.ts";
import type { CrmTask } from "./crm-tasks.ts";

/** The drag's own data type, so the grid takes only what the calendar started. */
export const DRAG_TYPE = "application/x-omni-calendar";

/** How long a timed to-do sits on the grid, in minutes. */
export const TODO_MINUTES = 30;

/** What is being dragged: one of the member's events, or a to-do. */
export type Dragged =
  | { kind: "event"; event: CalendarEvent; /** The day the dragged piece showed on. */ day?: Date }
  | { kind: "todo"; task: CrmTask };

/**
 * Where it was let go: a day, and on the hours, the wall-clock minute the dragged piece's top
 * lands on and how long the item ran before that top (`lead`, elapsed minutes).
 */
export interface Drop {
  day: Date;
  minutes?: number;
  lead?: number;
}

let current: { item: Dragged; grabMinutes: number; lead: number } | null = null;

/**
 * Starts a native drag of `item`. `grabMinutes` is how far below the shown top it was picked up,
 * so that top, not the pointer, lands on the slot; `lead` is how long the item ran before that
 * top (the night before, for the morning piece of an overnight event). The browser's data can't
 * be read until the drop, so the item rides here too.
 */
export function startDrag(
  event: { dataTransfer: DataTransfer },
  item: Dragged,
  grabMinutes = 0,
  lead = 0,
) {
  current = { item, grabMinutes, lead };
  event.dataTransfer.setData(DRAG_TYPE, item.kind === "event" ? item.event.id : item.task.id);
  event.dataTransfer.effectAllowed = "move";
}

/**
 * How long an item starting at `start` ran before the piece of `day` that shows from `from`:
 * the night before, for the morning piece of something that crosses midnight.
 */
export const leadOf = (day: Date, start: string, from: number) =>
  from === 0 ? Math.max(0, (day.getTime() - Date.parse(start)) / 60_000) : 0;

export const endDrag = () => {
  current = null;
};

/** The calendar drag under way, if any. */
export const dragging = () => current;

/** Whether a drag over the grid is the calendar's own. */
export const carriesCalendarDrag = (event: { dataTransfer: DataTransfer }) =>
  event.dataTransfer.types.includes(DRAG_TYPE);

/** How many minutes the dragged item spans on the grid. */
export const draggedLength = (item: Dragged) =>
  item.kind === "todo"
    ? TODO_MINUTES
    : Math.max(15, (Date.parse(item.event.end) - Date.parse(item.event.start)) / 60_000);

/**
 * Whether a to-do is due at a time of day: anything but the end of a day, which is how a
 * date-only due day is stored (`dueAtOf`).
 */
export function timedTodo(task: CrmTask) {
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt);
  return !(due.getHours() === 23 && due.getMinutes() === 59);
}

/** The moment `minutes` past local midnight of `day`. */
export const atMinutes = (day: Date, minutes: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);

const HOUR_MS = 3_600_000;

function slotOf(day: Date, minutes: number, was: Date) {
  const first = atMinutes(day, minutes);
  const second = new Date(first.getTime() + HOUR_MS);
  const repeated =
    second.getHours() === first.getHours() && second.getMinutes() === first.getMinutes();
  return repeated && second.getTimezoneOffset() === was.getTimezoneOffset() ? second : first;
}

/**
 * The instant a drop on the hours puts the item's start at, `was` being its start before: the
 * slot, less the elapsed lead. A wall-clock time the clocks pass twice (the hour they go back) is
 * read at the UTC offset the item had, so a drop back in place on the second pass stays there.
 */
export const dropStart = (drop: Drop & { minutes: number }, was: Date) =>
  new Date(slotOf(drop.day, drop.minutes, was).getTime() - (drop.lead ?? 0) * 60_000);
