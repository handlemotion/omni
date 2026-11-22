import { useRef } from "react";
import { crmErrorToast } from "@/components/crm/crm-errors.ts";
import { useUpdateCalendarTask } from "@/hooks/use-calendar-tasks.ts";
import type { CalendarEvent } from "@/lib/calendar.ts";
import { atMinutes, dropStart, type Dragged, type Drop } from "@/lib/calendar-drag.ts";
import { dayKey, parseDayKey } from "@/lib/calendar-grid.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import { dueAtOf } from "@/lib/crm-tasks.ts";
import { ownEvent } from "./week-grid.tsx";

const DAY_MINUTES = 24 * 60;

const daysBetween = (from: string, to: string) =>
  Math.round((parseDayKey(to).getTime() - parseDayKey(from).getTime()) / 86_400_000);

function shiftOf(event: CalendarEvent, drop: Drop, shownOn?: Date) {
  const start = new Date(event.start);
  const from = shownOn ? dayKey(shownOn) : (event.startDay ?? dayKey(start));
  const days = daysBetween(from, dayKey(drop.day));
  if (event.allDay) return days * DAY_MINUTES;
  const target =
    drop.minutes === undefined
      ? atMinutes(
          new Date(start.getFullYear(), start.getMonth(), start.getDate() + days),
          start.getHours() * 60 + start.getMinutes(),
        )
      : dropStart({ ...drop, minutes: drop.minutes }, start);
  return Math.round((target.getTime() - start.getTime()) / 60_000);
}

/**
 * What a drop on the calendar does. An event the member organizes moves there, keeping its
 * length (to the same time on another day, when let go on a day). A to-do takes the drop as its
 * due time: a time on the hours, or the day alone.
 */
export function useCalendarDrop(move: (event: CalendarEvent, minutes: number) => void) {
  const update = useUpdateCalendarTask();
  const saving = useRef(new Map<string, { last: Promise<unknown>; to: string | null }>());
  const save = (task: Todo, dueAt: string | null) => {
    const { id } = task;
    const queue = saving.current;
    const last = (queue.get(id)?.last ?? Promise.resolve())
      .then(() => update.mutateAsync({ id, dueAt, linked: !!task.record }))
      .catch((error: unknown) => crmErrorToast(error, "The to-do was not moved"));
    queue.set(id, { last, to: dueAt });
    void last.finally(() => queue.get(id)?.last === last && queue.delete(id));
  };
  const queuedDue = (task: Todo) => {
    const queued = saving.current.get(task.id);
    return queued ? queued.to : task.dueAt;
  };
  return (item: Dragged, drop: Drop) => {
    if (item.kind === "todo") {
      const dueAt =
        drop.minutes === undefined
          ? dueAtOf(dayKey(drop.day))
          : dropStart(
              { ...drop, minutes: drop.minutes },
              new Date(item.task.dueAt ?? Date.now()),
            ).toISOString();
      if (dueAt !== queuedDue(item.task)) save(item.task, dueAt);
      return;
    }
    if (!ownEvent(item.event)) return;
    const minutes = shiftOf(item.event, drop, item.day);
    if (minutes !== 0) move(item.event, minutes);
  };
}
