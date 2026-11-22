import type { CalendarEvent } from "@/lib/calendar.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import { addDays, dayKey, eventKey, parseDayKey } from "@/lib/calendar-grid.ts";
import { dayOf } from "@/lib/crm-tasks.ts";

const DAY_MS = 86_400_000;

/** One thing in a week of the month: an event over its days, or a dated to-do on one day. */
export type LaneItem =
  | { kind: "event"; key: string; event: CalendarEvent }
  | { kind: "todo"; key: string; task: Todo };

/** A run of an item along one lane of a week, `from` and `to` as day columns (to exclusive). */
export interface LanePiece {
  item: LaneItem;
  lane: number;
  from: number;
  to: number;
  /** Whether the item runs on past the run's start or end, so that side stays square. */
  before: boolean;
  after: boolean;
}

export interface WeekLanes {
  pieces: LanePiece[];
  /** Per day column: how many of its items don't fit, and the lane its "more" takes. */
  more: { count: number; lane: number }[];
}

function daysOf(event: CalendarEvent) {
  if (event.allDay) {
    if (!event.startDay || !event.endDay) return null;
    const last = dayKey(addDays(parseDayKey(event.endDay), -1));
    return [event.startDay, last < event.startDay ? event.startDay : last] as const;
  }
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const first = dayKey(new Date(start));
  if (end - start < DAY_MS) return [first, first] as const;
  return [first, dayKey(new Date(end - 1))] as const;
}

interface Placed {
  item: LaneItem;
  from: number;
  to: number;
  before: boolean;
  after: boolean;
  allDay: boolean;
  start: number;
}

function placedIn(week: readonly Date[], events: readonly CalendarEvent[], todos: readonly Todo[]) {
  const keys = week.map(dayKey);
  const first = keys[0] ?? "";
  const last = keys.at(-1) ?? "";
  const placed: Placed[] = [];
  for (const event of events) {
    const days = daysOf(event);
    if (!days || days[1] < first || days[0] > last) continue;
    const from = Math.max(0, keys.indexOf(days[0]));
    const end = keys.indexOf(days[1]);
    placed.push({
      item: { kind: "event", key: eventKey(event), event },
      from,
      to: end === -1 ? keys.length : end + 1,
      before: days[0] < first,
      after: days[1] > last,
      allDay: event.allDay,
      start: Date.parse(event.start),
    });
  }
  for (const task of todos) {
    const at = task.dueAt ? keys.indexOf(dayOf(task.dueAt)) : -1;
    if (at === -1) continue;
    placed.push({
      item: { kind: "todo", key: task.id, task },
      from: at,
      to: at + 1,
      before: false,
      after: false,
      allDay: false,
      start: Number.POSITIVE_INFINITY,
    });
  }
  return placed.toSorted(
    (a, b) =>
      a.from - b.from ||
      b.to - b.from - (a.to - a.from) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.start - b.start,
  );
}

/**
 * Lays a week's events and dated to-dos into lanes: an event over several days is one bar across
 * them, each item takes the lowest lane free on all its days, and a day with more than `fit`
 * lanes keeps one for its "more", hiding what falls there or below on that day alone.
 */
export function weekLanes(
  week: readonly Date[],
  events: readonly CalendarEvent[],
  todos: readonly Todo[],
  fit: number,
) {
  const taken: boolean[][] = week.map(() => []);
  const laid = placedIn(week, events, todos).map((placed) => {
    let lane = 0;
    while (taken.slice(placed.from, placed.to).some((day) => day[lane])) lane++;
    for (const day of taken.slice(placed.from, placed.to)) day[lane] = true;
    return { ...placed, lane };
  });
  const used = taken.map((day) => day.length);
  const limit = used.map((lanes) => (lanes > fit ? Math.max(0, fit - 1) : fit));
  const more = limit.map((lane, at) => ({
    lane,
    count: laid.filter((p) => p.from <= at && at < p.to && p.lane >= lane).length,
  }));
  const pieces: LanePiece[] = [];
  for (const placed of laid) {
    let run: number | null = null;
    for (let at = placed.from; at <= placed.to; at++) {
      const shows = at < placed.to && placed.lane < (limit[at] ?? 0);
      if (shows && run === null) run = at;
      if (shows || run === null) continue;
      pieces.push({
        item: placed.item,
        lane: placed.lane,
        from: run,
        to: at,
        before: run > placed.from || placed.before,
        after: at < placed.to || placed.after,
      });
      run = null;
    }
  }
  return { pieces, more } satisfies WeekLanes;
}
