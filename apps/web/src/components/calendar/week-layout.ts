import { useLayoutEffect, useMemo, useRef } from "react";
import { calendarTone, type CalendarEvent, type CalendarItem } from "@/lib/calendar.ts";
import { timedTodo, TODO_MINUTES } from "@/lib/calendar-drag.ts";
import { allDayOn, dayKey, placeDay, sameDay, type Timed } from "@/lib/calendar-grid.ts";
import { dayOf, type CrmTask } from "@/lib/crm-tasks.ts";
import type { TodoItem } from "./todo-block.tsx";
import type { Selection, WeekGridProps } from "./week-grid.tsx";

/** What a piece of the grid calls back, stable across renders. */
export interface Handlers {
  onSelect: WeekGridProps["onSelect"];
  onOpen: WeekGridProps["onOpen"];
  onCreate: WeekGridProps["onCreate"];
  onDrop?: WeekGridProps["onDrop"];
  onTodo?: WeekGridProps["onTodo"];
  onOpenTodo?: WeekGridProps["onOpenTodo"];
}

/** The grid's callbacks, stable across renders, always calling the latest props. */
export function useHandlers(props: WeekGridProps) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  return useMemo<Handlers>(
    () => ({
      onSelect: (selection) => latest.current.onSelect(selection),
      onOpen: (event) => latest.current.onOpen(event),
      onCreate: (slot) => latest.current.onCreate(slot),
      onDrop: (item, drop) => latest.current.onDrop?.(item, drop),
      onTodo: (task, done) => latest.current.onTodo?.(task, done),
      onOpenTodo: (task) => latest.current.onOpenTodo?.(task),
    }),
    [],
  );
}

/** An event or a timed to-do, placed on the hours. */
export type GridItem = ({ kind: "event"; event: CalendarEvent } | TodoItem) & Timed;

function itemsOf(events: readonly CalendarEvent[], todos: readonly CrmTask[]) {
  const items: GridItem[] = events.map((event) => ({
    kind: "event",
    event,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
  }));
  for (const task of todos.filter(timedTodo)) {
    items.push({
      kind: "todo",
      task,
      start: task.dueAt ?? "",
      end: new Date(Date.parse(task.dueAt ?? "") + TODO_MINUTES * 60_000).toISOString(),
      allDay: false,
    });
  }
  return items;
}

const NO_TODOS: readonly CrmTask[] = [];

/** Each day's placed items, all-day events and dated to-dos, worked out once per change. */
export function useLayout(
  days: readonly Date[],
  events: readonly CalendarEvent[],
  todos: readonly CrmTask[] = NO_TODOS,
) {
  return useMemo(() => {
    const items = itemsOf(events, todos);
    return days.map((day) => ({
      day,
      placed: placeDay(day, items),
      allDay: allDayOn(day, events),
      dayTodos: todos.filter(
        (task) => task.dueAt && !timedTodo(task) && dayOf(task.dueAt) === dayKey(day),
      ),
    }));
  }, [days, events, todos]);
}

/** Each shown calendar's colour. */
export function useTones(calendars: readonly CalendarItem[], events: readonly CalendarEvent[]) {
  return useMemo(() => {
    const tones = new Map<string, string>();
    for (const event of events) {
      if (!tones.has(event.calendarId))
        tones.set(event.calendarId, calendarTone(calendars, event.calendarId));
    }
    return tones;
  }, [calendars, events]);
}

/** The key of the selected event, if an event is selected. */
export const selectedKey = (selection: Selection) =>
  selection?.kind === "event" ? selection.key : null;
/** The selected slot, when it falls on `day`. */
export const chosenOn = (selection: Selection, day: Date) =>
  selection?.kind === "slot" && sameDay(selection.slot.start, day) ? selection.slot : null;
