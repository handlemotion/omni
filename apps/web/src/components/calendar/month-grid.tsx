import { cn } from "cn";
import { CanvasButton } from "@/components/ui/canvas-button";
import { calendarTone, type CalendarEvent } from "@/lib/calendar.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { addDays, dayKey, eventKey, parseDayKey, startOfWeek } from "@/lib/calendar-grid.ts";
import { dayOf } from "@/lib/crm-tasks.ts";
import { useDropZone } from "./drop-zone.ts";
import { weekLanes, type LanePiece } from "./month-lanes.ts";
import { firstOf, monthOf } from "./month-span.ts";
import { TodoChip } from "./todo-block.tsx";
import { Chip, type WeekGridProps } from "./week-grid.tsx";
import { selectedKey, useHandlers, type Handlers } from "./week-layout.ts";

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const WEEK_MS = 7 * 86_400_000;

type MonthGridProps = WeekGridProps & {
  /** The shown day: its month leads the title and is scrolled to when it changes from outside. */
  anchor: Date;
  /** The month most of the page shows now, ahead of the URL while it scrolls. */
  shown: Date;
  /** Counts the arrows' and Today's presses: each scrolls to the anchor's month, even unchanged. */
  aimed: { at: string; count: number };
  onDay: (day: Date) => void;
  /** Whether the page itself wrote this date to the URL after a scroll; it is not scrolled to. */
  ownWrite: (key: string) => boolean;
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
    const own = fresh && props.ownWrite(anchorKey);
    const settled = !fresh || shown.current === anchorKey || own;
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

interface WeekItems {
  events: CalendarEvent[];
  todos: Todo[];
}

const same = <T,>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, at) => item === b[at]);

const NO_TODOS: readonly Todo[] = [];

function useWeekItems(props: MonthGridProps, weeks: readonly (readonly Date[])[]) {
  const { events } = props;
  const todos = props.todos ?? NO_TODOS;
  const before = useRef(new Map<string, WeekItems>());
  return useMemo(() => {
    const byWeek = new Map<string, WeekItems>();
    for (const week of weeks) {
      const first = week[0];
      if (!first) continue;
      const from = first.getTime();
      const to = addDays(first, 7).getTime();
      const fromKey = dayKey(first);
      const toKey = dayKey(addDays(first, 7));
      const inWeek = events.filter((e) =>
        e.allDay
          ? !!e.startDay && !!e.endDay && e.startDay < toKey && e.endDay > fromKey
          : Date.parse(e.start) < to && Date.parse(e.end) > from,
      );
      const dated = todos.filter(
        (t) => t.dueAt && dayOf(t.dueAt) >= fromKey && dayOf(t.dueAt) < toKey,
      );
      if (inWeek.length === 0 && dated.length === 0) continue;
      const key = dayKey(first);
      const was = before.current.get(key);
      byWeek.set(
        key,
        was && same(was.events, inWeek) && same(was.todos, dated)
          ? was
          : { events: inWeek, todos: dated },
      );
    }
    before.current = byWeek;
    return byWeek;
  }, [weeks, events, todos]);
}

const LANE_PX = 22;
const LANES_TOP_PX = 28;

function useFit(scroller: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState(3);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setFit(Math.max(1, Math.floor((rowHeight(element) - LANES_TOP_PX) / LANE_PX)));
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    return () => resized.disconnect();
  }, [scroller]);
  return fit;
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
  const byWeek = useWeekItems(props, weeks);
  const fit = useFit(scroller);
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
        {weeks.map((week) => {
          const items = byWeek.get(dayKey(week[0] ?? props.now)) ?? NONE;
          return (
            <MonthWeek
              key={week[0]?.getTime()}
              week={week}
              items={items}
              fit={fit}
              inMonth={week.map((day) => (day.getMonth() === month ? "1" : "0")).join("")}
              today={week.some((day) => dayKey(day) === today) ? today : null}
              picked={items.events.some((e) => eventKey(e) === picked) ? picked : null}
              calendars={props.calendars}
              handlers={handlers}
              onDay={onDay}
            />
          );
        })}
      </div>
    </div>
  );
}

const NONE: WeekItems = { events: [], todos: [] };

const MonthWeek = memo(function MonthWeek(props: {
  week: readonly Date[];
  items: WeekItems;
  fit: number;
  inMonth: string;
  today: string | null;
  picked: string | null;
  calendars: MonthGridProps["calendars"];
  handlers: Handlers;
  onDay: (day: Date) => void;
}) {
  const { week, items, fit } = props;
  const lanes = useMemo(() => weekLanes(week, items.events, items.todos, fit), [week, items, fit]);
  const first = week[0];
  return (
    <div
      data-week={first && dayKey(first)}
      className="relative grid h-[calc(100cqh/6)] grid-cols-7 [content-visibility:auto]"
    >
      {week.map((day, at) => (
        <MonthDay
          key={day.getTime()}
          day={day}
          at={at}
          pieces={lanes.pieces.filter((piece) => piece.from === at)}
          more={lanes.more[at] ?? { count: 0, lane: 0 }}
          inMonth={props.inMonth[at] === "1"}
          today={dayKey(day) === props.today}
          picked={props.picked}
          calendars={props.calendars}
          handlers={props.handlers}
          onDay={props.onDay}
        />
      ))}
    </div>
  );
});

const placeAt = (lane: number, from: number, to: number) => ({
  top: LANES_TOP_PX + lane * LANE_PX,
  left: `calc(${from} * 100% / 7 + 4px)`,
  width: `calc(${to - from} * 100% / 7 - 7px)`,
});

function MonthPiece(props: {
  piece: LanePiece;
  picked: string | null;
  calendars: MonthGridProps["calendars"];
  handlers: Handlers;
}) {
  const { piece, handlers } = props;
  const { item } = piece;
  const style = placeAt(piece.lane, piece.from, piece.to);
  if (item.kind === "todo") {
    return (
      <div className="absolute" style={style}>
        <TodoChip task={item.task} onTodo={handlers.onTodo} onOpenTodo={handlers.onOpenTodo} />
      </div>
    );
  }
  return (
    <Chip
      event={item.event}
      timed
      tone={calendarTone(props.calendars, item.event.calendarId)}
      selected={props.picked === item.key}
      handlers={handlers}
      className={cn(
        "absolute h-5 py-0 text-sm",
        piece.before && "rounded-s-none",
        piece.after && "rounded-e-none",
      )}
      style={style}
    />
  );
}

const MonthDay = memo(function MonthDay(props: {
  day: Date;
  at: number;
  pieces: LanePiece[];
  more: { count: number; lane: number };
  inMonth: boolean;
  today: boolean;
  picked: string | null;
  calendars: MonthGridProps["calendars"];
  handlers: Handlers;
  onDay: (day: Date) => void;
}) {
  const { day, handlers, more } = props;
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const zone = useDropZone(day, false, handlers.onDrop);
  return (
    <div
      data-month-day={dayKey(day)}
      {...zone.handlers}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-l border-calendar-line p-1 first:border-l-0",
        weekend && "bg-calendar-weekend",
        zone.over && "bg-primary-subtle",
      )}
    >
      <CanvasButton
        aria-label={`Open ${day.toDateString()}`}
        onClick={() => props.onDay(day)}
        className={cn(
          "grid h-5 min-w-5 place-items-center self-start rounded-md px-1 text-xs tabular-nums",
          props.inMonth ? "text-foreground" : "text-subtle-foreground",
          props.today && "bg-module-calendar font-medium text-primary-foreground",
        )}
      >
        {day.getDate() === 1 ? monthDay.format(day) : day.getDate()}
      </CanvasButton>
      {props.pieces.map((piece) => (
        <MonthPiece
          key={`${piece.item.key}:${piece.from}`}
          piece={piece}
          picked={props.picked}
          calendars={props.calendars}
          handlers={handlers}
        />
      ))}
      {more.count > 0 && (
        <CanvasButton
          onClick={() => props.onDay(day)}
          className="absolute flex h-5 items-center rounded-md px-1.5 text-sm text-muted-foreground hover:bg-hover"
          style={placeAt(more.lane, props.at, props.at + 1)}
        >
          {more.count} more
        </CanvasButton>
      )}
    </div>
  );
});
