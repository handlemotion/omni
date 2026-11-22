import type { CalendarEvent } from "./calendar.ts";

export type CalendarView = "week" | "day";

export const HOUR_PX = 48;
export const SLOT_MINUTES = 15;

/** Local midnight of `date`. */
export const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** The Monday of `date`'s week, at local midnight. */
export function startOfWeek(date: Date) {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** The days a view shows around `anchor`: a week from Monday, or the one day. */
export const daysOf = (view: CalendarView, anchor: Date) =>
  view === "day"
    ? [startOfDay(anchor)]
    : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));

/** `YYYY-MM-DD` of a local date, for the URL. */
export const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** The local date a `YYYY-MM-DD` names; today for anything else. */
export function parseDayKey(value: string | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return startOfDay(new Date());
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime();

/** A selected stretch of time on the grid, in whole slots. */
export interface Slot {
  start: Date;
  end: Date;
}

/** The slot `minutes` past midnight of `day`, `length` minutes long. */
export function slotAt(day: Date, minutes: number, length = 30) {
  const snapped = Math.max(
    0,
    Math.min(24 * 60 - SLOT_MINUTES, Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES),
  );
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, snapped);
  return { start, end: new Date(start.getTime() + length * 60_000) } satisfies Slot;
}

/** The next half hour from now, on today. */
export function nextHalfHour(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return slotAt(startOfDay(now), Math.ceil(minutes / 30) * 30);
}

/**
 * Where `at` falls on `day`'s column, in minutes of wall-clock time from its midnight: 0 before
 * the day, 24 hours after it. A day that gains or loses an hour keeps every hour under its label.
 */
export function minutesInto(day: Date, at: Date) {
  if (at.getTime() <= startOfDay(day).getTime()) return 0;
  if (at.getTime() >= addDays(day, 1).getTime()) return 24 * 60;
  return at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
}

/** An event's piece on one day column, placed beside the events it overlaps. */
export interface Placed {
  event: CalendarEvent;
  /** Minutes from the day's midnight, clipped to the day. */
  from: number;
  to: number;
  column: number;
  columns: number;
}

/** A stable key for an event or one instance of a series. */
export const eventKey = (event: Pick<CalendarEvent, "id" | "recurrenceId">) =>
  event.recurrenceId ? `${event.id}@${event.recurrenceId}` : event.id;

/**
 * The timed events of one day, each placed in a column of its overlap cluster, so overlapping
 * events share the width side by side and the rest take it all.
 */
export function placeDay(day: Date, events: readonly CalendarEvent[]) {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const pieces = events
    .filter((e) => !e.allDay && Date.parse(e.start) < dayEnd && Date.parse(e.end) > dayStart)
    .map((event) => {
      const from = minutesInto(day, new Date(event.start));
      const to = minutesInto(day, new Date(event.end));
      return { event, from, to: Math.max(to, from + SLOT_MINUTES) };
    })
    .toSorted((a, b) => a.from - b.from || b.to - a.to);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const close = () => {
    const columns = Math.max(1, ...cluster.map((p) => p.column + 1));
    for (const piece of cluster) piece.columns = columns;
    cluster = [];
  };
  for (const piece of pieces) {
    if (piece.from >= clusterEnd) close();
    const taken = new Set(cluster.filter((p) => p.to > piece.from).map((p) => p.column));
    let column = 0;
    while (taken.has(column)) column++;
    const one = { ...piece, column, columns: 1 };
    cluster.push(one);
    placed.push(one);
    clusterEnd = Math.max(clusterEnd, piece.to);
  }
  close();
  return placed;
}

/** The all-day events that cover `day`. */
export const allDayOn = (day: Date, events: readonly CalendarEvent[]) => {
  const key = dayKey(day);
  return events.filter(
    (e) => e.allDay && e.startDay && e.endDay && e.startDay <= key && key < e.endDay,
  );
};
