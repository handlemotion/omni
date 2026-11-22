import { useRef, type MouseEvent } from "react";
import {
  IconCalendarDay,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconEye,
  IconPencil,
  IconPlus,
  IconCircleHelp,
  IconRestore,
  IconTrash,
  IconVideo,
} from "@/components/icons/central";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import { appToast } from "@/components/ui/toast";
import { useCalendarWrites } from "@/hooks/use-calendar.ts";
import type { CalendarEvent } from "@/lib/calendar.ts";
import { eventKey, HOUR_PX, parseDayKey, slotAt, type Slot } from "@/lib/calendar-grid.ts";
import type { CrmTask } from "@/lib/crm-tasks.ts";
import { answerable } from "./event-panel.tsx";
import { ownEvent } from "./week-grid.tsx";

const NINE = 9 * 60;

/**
 * The grid's right-click menu, read from what was clicked: an event's Open, Edit, answers and
 * Delete; a to-do's check; a stretch of a day's hours, a day of the month or its all-day row, a
 * New event there.
 */
export function useCalendarMenu(props: {
  events: readonly CalendarEvent[];
  todos: readonly CrmTask[];
  onOpen: (event: CalendarEvent) => void;
  onEdit: (event: CalendarEvent) => void;
  onCreate: (slot: Slot) => void;
  onDay?: (day: Date) => void;
  onTodo: (task: CrmTask, done: boolean) => void;
}) {
  const { answer, remove } = useCalendarWrites();
  const pointerY = useRef(0);

  const eventEntries = (event: CalendarEvent) => {
    const reply = (response: "accepted" | "declined" | "tentative") => () =>
      answer.mutate(
        { id: event.id, response },
        { onError: () => appToast.error("The answer was not sent") },
      );
    const canAnswer = answerable(event);
    return [
      { icon: IconEye, label: "Open", onAction: () => props.onOpen(event) },
      ownEvent(event) && { icon: IconPencil, label: "Edit", onAction: () => props.onEdit(event) },
      event.conferenceUrl && {
        icon: IconVideo,
        label: "Join",
        onAction: () => window.open(event.conferenceUrl ?? "", "_blank", "noopener"),
      },
      canAnswer && "separator",
      canAnswer && { icon: IconCircleCheck, label: "Yes", onAction: reply("accepted") },
      canAnswer && { icon: IconCircleX, label: "No", onAction: reply("declined") },
      canAnswer && { icon: IconCircleHelp, label: "Maybe", onAction: reply("tentative") },
      ownEvent(event) && "separator",
      ownEvent(event) && {
        icon: IconTrash,
        label: "Delete and tell guests",
        danger: true,
        onAction: () =>
          remove.mutate(event.id, {
            onError: () => appToast.error("The event was not deleted"),
          }),
      },
    ] satisfies ContextMenuEntry[];
  };

  const dayEntries = (day: Date, minutes: number) =>
    [
      { icon: IconPlus, label: "New event", onAction: () => props.onCreate(slotAt(day, minutes)) },
      props.onDay && {
        icon: IconCalendarDay,
        label: "Open day",
        onAction: () => props.onDay?.(day),
      },
    ] satisfies ContextMenuEntry[];

  const menu = (target: Element) => {
    const todoId = target.closest("[data-todo]")?.getAttribute("data-todo");
    const task = todoId ? props.todos.find((t) => t.id === todoId) : undefined;
    if (task) {
      const done = !!task.completedAt;
      return [
        {
          icon: done ? IconRestore : IconCheck,
          label: done ? "Reopen" : "Complete",
          onAction: () => props.onTodo(task, !done),
        },
      ] satisfies ContextMenuEntry[];
    }
    const key = target.closest("[data-event]")?.getAttribute("data-event");
    const event = key ? props.events.find((e) => eventKey(e) === key) : undefined;
    if (event) return eventEntries(event);
    const column = target.closest("[data-day]");
    if (column) {
      const top = column.getBoundingClientRect().top;
      const minutes = ((pointerY.current - top) / HOUR_PX) * 60 - 7.5;
      return dayEntries(parseDayKey(column.getAttribute("data-day") ?? undefined), minutes);
    }
    const day =
      target.closest("[data-month-day]")?.getAttribute("data-month-day") ??
      target.closest("[data-all-day]")?.getAttribute("data-all-day");
    return day ? dayEntries(parseDayKey(day), NINE) : null;
  };

  const { onContextMenu } = contextMenuProps(menu, "Calendar actions");
  return {
    onContextMenu: (event: MouseEvent) => {
      pointerY.current = event.clientY;
      onContextMenu(event);
    },
  };
}
