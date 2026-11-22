import { cn } from "cn";
import { CanvasButton } from "@/components/ui/canvas-button";
import { calendarTone, type CalendarEvent } from "@/lib/calendar.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  addDays,
  allDayOn,
  dayKey,
  eventKey,
  parseDayKey,
  startOfWeek,
} from "@/lib/calendar-grid.ts";
import { dayOf } from "@/lib/crm-tasks.ts";
import { useDropZone } from "./drop-zone.ts";
import { firstOf, monthOf } from "./month-span.ts";
import { TodoChip } from "./todo-block.tsx";
import { Chip, type WeekGridProps } from "./week-grid.tsx";
import { selectedKey, useHandlers, type Handlers } from "./week-layout.ts";

const SHOWN = 3;
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const WEEK_MS = 7 * 86_400_000;

const timedOn = (day: Date, events: readonly CalendarEvent[]) => {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  return events
    .filter((e) => !e.allDay && Date.parse(e.start) < end && Date.parse(e.end) > start)
    .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
};

type MonthGridProps = WeekGridProps & {
  /** The shown day: its month leads the title and is scrolled to when it changes from outside. */
  anchor: Date;
  /** The month most of the page shows now, ahead of the URL while it scrolls. */
  shown: Date;
  /** Counts the arrows' and Today's presses: each scrolls to the anchor's month, even unchanged. */
  aimed: { at: string; count: number };
  onDay: (day: Date) => void;
  /** The month most of the page shows changed, by scrolling. */
  onMonth: (first: Date) => void;
  /** The page came near the end of its weeks: lay out more months that way. */
  onExtend: (direction: 1 | -1) => void;
};

const rowHeight = (scroller: HTMLElement) =>
  scroller.querySelector("[data-week]")?.getBoundingClientRect().height || 1;

const GLIDE_MS = 320;
const EDGE_ROWS = 8;
const glides = new WeakMap<HTMLElement, number>();

const stopGlide = (element: HTMLElement) => glides.set(element, (glides.get(element) ?? 0) + 1);

function glide(element: HTMLElement, top: number, done: () => void) {
  stopGlide(element);
  const run = glides.get(element);
  const start = element.scrollTop;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let began: number | null = null;
  const tick = (now: number) => {
    if (glides.get(element) !== run) return;
    began ??= now;
    const t = still ? 1 : Math.min(1, (now - began) / GLIDE_MS);
    element.scrollTop = start + (top - start) * (1 - (1 - t) ** 3);
    if (t < 1) requestAnimationFrame(tick);
    else done();
  };
  requestAnimationFrame(tick);
}

function monthInView(scroller: HTMLElement, weeks: readonly (readonly Date[])[]) {
  const height = rowHeight(scroller);
  const top = Math.round(scroller.scrollTop / height);
  const bottom = Math.round((scroller.scrollTop + scroller.clientHeight) / height);
  const counts = new Map<number, number>();
  for (const week of weeks.slice(top, Math.max(top + 1, bottom))) {
    for (const day of week) counts.set(monthOf(day), (counts.get(monthOf(day)) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [month, count] of counts)
    if (best === null || count > (counts.get(best) ?? 0)) best = month;
  return best;
}

function useMonthScroll(props: MonthGridProps, weeks: readonly (readonly Date[])[]) {
  const scroller = useRef<HTMLDivElement>(null);
  const first = props.days[0]?.getTime() ?? 0;
  const last = props.days.at(-1)?.getTime() ?? 0;
  const laidFrom = useRef(first);
  const shown = useRef<string | null>(null);
  const guided = useRef(false);
  const asked = useRef({ before: Number.NaN, after: Number.NaN });
  const latest = useRef({ props, weeks, first, last });
  latest.current = { props, weeks, first, last };
  const anchorKey = dayKey(props.anchor);
  const aimedAt = useRef(props.aimed.count);
  const reported = useRef<string[]>([]);
  const handled = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = scroller.current;
    const added = Math.round((laidFrom.current - first) / WEEK_MS);
    laidFrom.current = first;
    if (element && added !== 0) element.scrollTop += added * rowHeight(element);
  }, [first]);

  useLayoutEffect(() => {
    const element = scroller.current;
    const aimedHere = props.aimed.at === anchorKey && aimedAt.current !== props.aimed.count;
    const fresh = handled.current !== anchorKey;
    handled.current = anchorKey;
    const landed = reported.current.indexOf(anchorKey);
    if (landed >= 0) reported.current.splice(0, landed + 1);
    const settled = !fresh || shown.current === anchorKey || landed >= 0;
    if (!element || (settled && !aimedHere)) return;
    if (props.aimed.at === anchorKey) aimedAt.current = props.aimed.count;
    const month = monthOf(props.anchor);
    const from = shown.current === null ? null : monthOf(parseDayKey(shown.current));
    shown.current = anchorKey;
    const row = element.querySelector<HTMLElement>(
      `[data-week="${dayKey(startOfWeek(firstOf(month)))}"]`,
    );
    if (!row) return;
    if (from === null || Math.abs(month - from) > 2) {
      stopGlide(element);
      guided.current = false;
      element.scrollTop = row.offsetTop;
      return;
    }
    guided.current = true;
    glide(element, row.offsetTop, () => {
      guided.current = false;
      element.dispatchEvent(new Event("scroll"));
    });
  }, [anchorKey, props.anchor, props.aimed]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const report = () => {
      frame = 0;
      if (guided.current) return;
      const now = latest.current;
      const height = rowHeight(element);
      const below = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (element.scrollTop < EDGE_ROWS * height && asked.current.before !== now.first) {
        asked.current.before = now.first;
        now.props.onExtend(-1);
      }
      if (below < EDGE_ROWS * height && asked.current.after !== now.last) {
        asked.current.after = now.last;
        now.props.onExtend(1);
      }
      const month = monthInView(element, now.weeks);
      if (month === null || month === monthOf(parseDayKey(shown.current ?? ""))) return;
      shown.current = dayKey(firstOf(month));
      reported.current.push(shown.current);
      now.props.onMonth(firstOf(month));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(report);
    };
    let laidHeight = rowHeight(element);
    const resized = new ResizeObserver(() => {
      const height = rowHeight(element);
      if (height === laidHeight) return;
      element.scrollTop = (element.scrollTop / laidHeight) * height;
      laidHeight = height;
    });
    resized.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

  return scroller;
}

interface DayItems {
  events: CalendarEvent[];
  todos: Todo[];
}

const same = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, at) => item === b[at]);

function useDayItems(props: MonthGridProps) {
  const { days, events, todos } = props;
  const before = useRef(new Map<string, DayItems>());
  return useMemo(() => {
    const byDay = new Map<string, DayItems>();
    for (const day of days) {
      const key = dayKey(day);
      const onDay = [...allDayOn(day, events), ...timedOn(day, events)];
      const dated = (todos ?? []).filter((task) => task.dueAt && dayOf(task.dueAt) === key);
      if (onDay.length === 0 && dated.length === 0) continue;
      const was = before.current.get(key);
      byDay.set(
        key,
        was && same(was.events, onDay) && same(was.todos, dated)
          ? was
          : { events: onDay, todos: dated },
      );
    }
    before.current = byDay;
    return byDay;
  }, [days, events, todos]);
}

/**
 * The months as one long page of weeks that scrolls freely, each day with its first events and
 * dated to-dos; a day's number opens it, and so does its "more" when it holds more than fit.
 */
export function MonthGrid(props: MonthGridProps) {
  const weeks = useMemo(
    () =>
      Array.from({ length: props.days.length / 7 }, (_, i) => props.days.slice(i * 7, i * 7 + 7)),
    [props.days],
  );
  const scroller = useMonthScroll(props, weeks);
  const handlers = useHandlers(props);
  const latest = useRef(props.onDay);
  useLayoutEffect(() => {
    latest.current = props.onDay;
  });
  const onDay = useCallback((day: Date) => latest.current(day), []);
  const byDay = useDayItems(props);
  const month = props.shown.getMonth();
  const today = dayKey(props.now);
  const picked = selectedKey(props.selection);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b">
        {weeks[0]?.map((day) => (
          <span key={day.getTime()} className="py-2 text-center text-sm text-muted-foreground">
            {weekday.format(day)}
          </span>
        ))}
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto [container-type:size] [overflow-anchor:none]"
      >
        {weeks.map((week) => (
          <MonthWeek
            key={week[0]?.getTime()}
            week={week}
            byDay={byDay}
            inMonth={week.map((day) => (day.getMonth() === month ? "1" : "0")).join("")}
            today={week.some((day) => dayKey(day) === today) ? today : null}
            picked={
              week.some((day) => byDay.get(dayKey(day))?.events.some((e) => eventKey(e) === picked))
                ? picked
                : null
            }
            calendars={props.calendars}
            handlers={handlers}
            onDay={onDay}
          />
        ))}
      </div>
    </div>
  );
}

const NONE: DayItems = { events: [], todos: [] };

const MonthWeek = memo(function MonthWeek(props: {
  week: readonly Date[];
  byDay: ReadonlyMap<string, DayItems>;
  inMonth: string;
  today: string | null;
  picked: string | null;
  calendars: MonthGridProps["calendars"];
  handlers: Handlers;
  onDay: (day: Date) => void;
}) {
  const first = props.week[0];
  return (
    <div
      data-week={first && dayKey(first)}
      className="grid h-[calc(100cqh/6)] grid-cols-7 [content-visibility:auto]"
    >
      {props.week.map((day, at) => {
        const items = props.byDay.get(dayKey(day)) ?? NONE;
        return (
          <MonthDay
            key={day.getTime()}
            day={day}
            items={items}
            inMonth={props.inMonth[at] === "1"}
            today={dayKey(day) === props.today}
            picked={items.events.some((e) => eventKey(e) === props.picked) ? props.picked : null}
            calendars={props.calendars}
            handlers={props.handlers}
            onDay={props.onDay}
          />
        );
      })}
    </div>
  );
});

const MonthDay = memo(function MonthDay(props: {
  day: Date;
  items: DayItems;
  inMonth: boolean;
  today: boolean;
  picked: string | null;
  calendars: MonthGridProps["calendars"];
  handlers: Handlers;
  onDay: (day: Date) => void;
}) {
  const { day, items, handlers } = props;
  const { events, todos } = items;
  const more = Math.max(0, events.length + todos.length - SHOWN);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const zone = useDropZone(day, false, handlers.onDrop);
  return (
    <div
      data-month-day={dayKey(day)}
      {...zone.handlers}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-b border-l border-calendar-line p-1 first:border-l-0",
        weekend && "bg-calendar-weekend",
        zone.over && "bg-primary-subtle",
      )}
    >
      <CanvasButton
        aria-label={`Open ${day.toDateString()}`}
        onClick={() => props.onDay(day)}
        className={cn(
          "mb-1 grid h-5 min-w-5 place-items-center self-start rounded-md px-1 text-xs tabular-nums",
          props.inMonth ? "text-foreground" : "text-subtle-foreground",
          props.today && "bg-module-calendar font-medium text-primary-foreground",
        )}
      >
        {day.getDate() === 1 ? monthDay.format(day) : day.getDate()}
      </CanvasButton>
      {events.slice(0, SHOWN).map((event) => (
        <Chip
          key={eventKey(event)}
          event={event}
          timed
          tone={calendarTone(props.calendars, event.calendarId)}
          selected={props.picked === eventKey(event)}
          handlers={handlers}
        />
      ))}
      {todos.slice(0, Math.max(0, SHOWN - events.length)).map((task) => (
        <TodoChip
          key={task.id}
          task={task}
          onTodo={handlers.onTodo}
          onOpenTodo={handlers.onOpenTodo}
        />
      ))}
      {more > 0 && (
        <CanvasButton
          onClick={() => props.onDay(day)}
          className="self-start rounded-md px-1.5 text-xs text-muted-foreground hover:bg-hover"
        >
          {more} more
        </CanvasButton>
      )}
    </div>
  );
});
