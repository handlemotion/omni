import { cn } from "cn";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { IconPlus } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { CanvasButton } from "@/components/ui/canvas-button";
import type { CalendarEvent, CalendarItem } from "@/lib/calendar.ts";
import { endDrag, leadOf, startDrag, type Dragged, type Drop } from "@/lib/calendar-drag.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import { useDropZone } from "./drop-zone.ts";
import { TodoBlock, TodoChip } from "./todo-block.tsx";
import {
  chosenOn,
  selectedKey,
  useHandlers,
  useLayout,
  useTones,
  type GridItem,
  type Handlers,
} from "./week-layout.ts";
import {
  dayKey,
  eventKey,
  HOUR_PX,
  minutesInto,
  sameDay,
  type Placed,
  SLOT_MINUTES,
  slotAt,
  type Slot,
} from "@/lib/calendar-grid.ts";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export type Selection = { kind: "slot"; slot: Slot } | { kind: "event"; key: string } | null;

export interface WeekGridProps {
  days: Date[];
  events: readonly CalendarEvent[];
  calendars: readonly CalendarItem[];
  selection: Selection;
  now: Date;
  onSelect: (selection: Selection) => void;
  onOpen: (event: CalendarEvent) => void;
  onCreate: (slot: Slot) => void;
  onMove: (event: CalendarEvent, minutes: number) => void;
  /** The member's open to-dos; each dated one sits on its day's all-day row. */
  todos?: readonly Todo[];
  onTodo?: (task: Todo, done: boolean) => void;
  /** A new event at the selection, from the grid's corner. */
  onNew?: () => void;
  /** Something the calendar dragged was let go on a day, or a time on it. */
  onDrop?: (item: Dragged, drop: Drop) => void;
  /** Opens a to-do beside the calendar. */
  onOpenTodo?: (task: Todo) => void;
}

/** Whether the member may move it: an event made in Omni that their inbox organizes. */
export const ownEvent = (event: CalendarEvent) => event.source === "omni" && event.organizing;

const snap = (minutes: number) => Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

/** The week or the day: an all-day strip, then the hours with each day's events in place. */
export function WeekGrid(props: WeekGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const handlers = useHandlers(props);
  const layout = useLayout(props.days, props.events, props.todos);
  const tones = useTones(props.calendars, props.events);
  const picked = selectedKey(props.selection);
  useEffect(() => {
    const hour = Math.max(0, props.now.getHours() - 2);
    scroller.current?.scrollTo({ top: hour * HOUR_PX });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const columns = { gridTemplateColumns: `4.5rem repeat(${props.days.length}, minmax(0, 1fr))` };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid border-b" style={columns}>
        <div className="flex items-center justify-end pe-1">
          <Button size="sq-xs" intent="plain" aria-label="New event" onPress={props.onNew}>
            <IconPlus />
          </Button>
        </div>
        {props.days.map((day) => (
          <DayHeading key={day.getTime()} day={day} today={sameDay(day, props.now)} />
        ))}
      </div>
      <div className="grid border-b" style={columns}>
        <span className="pe-2 pt-1.5 text-end text-xs text-muted-foreground">All day</span>
        {layout.map(({ day, allDay, dayTodos }) => (
          <AllDayCell
            key={day.getTime()}
            day={day}
            events={allDay}
            todos={dayTodos}
            tones={tones}
            picked={picked}
            handlers={handlers}
          />
        ))}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ ...columns, height: 24 * HOUR_PX }}>
          <div className="relative">
            {HOURS.slice(1).map((hour) => (
              <span
                key={hour}
                className="absolute end-2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums"
                style={{ top: hour * HOUR_PX }}
              >
                {hourLabel.format(new Date(2026, 0, 1, hour))}
              </span>
            ))}
            {props.days.some((day) => sameDay(day, props.now)) && (
              <span
                className="absolute end-1.5 z-10 -translate-y-1/2 rounded-sm bg-background px-0.5 text-xs font-medium text-module-calendar tabular-nums"
                style={{ top: (minutesInto(startOfDayOf(props.now), props.now) / 60) * HOUR_PX }}
              >
                {time.format(props.now)}
              </span>
            )}
          </div>
          {layout.map(({ day, placed }) => (
            <DayColumn
              key={day.getTime()}
              day={day}
              placed={placed}
              tones={tones}
              chosen={chosenOn(props.selection, day)}
              picked={
                placed.some((p) => p.event.kind === "event" && eventKey(p.event.event) === picked)
                  ? picked
                  : null
              }
              now={props.now}
              handlers={handlers}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const weekend = (day: Date) => day.getDay() === 0 || day.getDay() === 6;
const startOfDayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function DayHeading({ day, today }: { day: Date; today: boolean }) {
  return (
    <div
      className={cn(
        "flex h-10 items-center justify-center gap-1.5 text-sm",
        today ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span>{weekday.format(day)}</span>
      <span
        className={cn(
          "grid h-5 min-w-5 place-items-center rounded-md px-1 tabular-nums",
          today && "bg-module-calendar font-medium text-primary-foreground",
        )}
      >
        {day.getDate()}
      </span>
    </div>
  );
}

interface PieceProps {
  tone: string;
  selected: boolean;
  handlers: Handlers;
}

const AllDayCell = memo(function AllDayCell(props: {
  day: Date;
  events: readonly CalendarEvent[];
  todos: readonly Todo[];
  tones: ReadonlyMap<string, string>;
  picked: string | null;
  handlers: Handlers;
}) {
  const { day, handlers } = props;
  const zone = useDropZone(day, false, handlers.onDrop);
  return (
    <div
      data-all-day={dayKey(day)}
      {...zone.handlers}
      className={cn(
        "flex min-h-8 flex-col gap-0.5 border-l border-calendar-line p-1",
        weekend(day) && "bg-calendar-weekend",
        zone.over && "bg-primary-subtle",
      )}
    >
      {props.events.map((event) => (
        <Chip
          key={eventKey(event)}
          event={event}
          day={day}
          tone={props.tones.get(event.calendarId) ?? ""}
          selected={props.picked === eventKey(event)}
          handlers={handlers}
        />
      ))}
      {props.todos.map((task) => (
        <TodoChip
          key={task.id}
          task={task}
          onTodo={handlers.onTodo}
          onOpenTodo={handlers.onOpenTodo}
        />
      ))}
    </div>
  );
});

interface DayColumnProps {
  day: Date;
  placed: Placed<GridItem>[];
  tones: ReadonlyMap<string, string>;
  chosen: Slot | null;
  picked: string | null;
  now: Date;
  handlers: Handlers;
}

const DayColumn = memo(function DayColumn(props: DayColumnProps) {
  const [sweep, setSweep] = useState<{ from: number; to: number } | null>(null);
  const zone = useDropZone(props.day, true, props.handlers.onDrop);
  const minutesAt = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return ((event.clientY - box.top) / HOUR_PX) * 60;
  };
  const { chosen } = props;
  return (
    <div
      role="presentation"
      data-day={dayKey(props.day)}
      className={cn(
        "relative border-l border-calendar-line",
        weekend(props.day) && "bg-calendar-weekend",
      )}
      {...zone.handlers}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = snap(minutesAt(event) - SLOT_MINUTES / 2);
        setSweep({ from: at, to: at + 30 });
      }}
      onPointerMove={(event) => {
        if (!sweep) return;
        setSweep({ ...sweep, to: Math.max(sweep.from + SLOT_MINUTES, snap(minutesAt(event))) });
      }}
      onPointerUp={() => {
        if (!sweep) return;
        props.handlers.onSelect({
          kind: "slot",
          slot: slotAt(props.day, sweep.from, sweep.to - sweep.from),
        });
        setSweep(null);
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        props.handlers.onCreate(slotAt(props.day, snap(minutesAt(event) - SLOT_MINUTES / 2)));
      }}
    >
      {HOURS.map((hour) => (
        <div
          key={hour}
          className="pointer-events-none absolute inset-x-0 border-t border-calendar-line"
          style={{ top: hour * HOUR_PX }}
        />
      ))}
      {(sweep || chosen) && (
        <div
          className="pointer-events-none absolute inset-x-1 rounded-sm bg-primary-subtle"
          style={
            sweep
              ? {
                  top: (sweep.from / 60) * HOUR_PX,
                  height: ((sweep.to - sweep.from) / 60) * HOUR_PX,
                }
              : chosen
                ? {
                    top: (minutesInto(props.day, chosen.start) / 60) * HOUR_PX,
                    height: ((chosen.end.getTime() - chosen.start.getTime()) / 3_600_000) * HOUR_PX,
                  }
                : undefined
          }
        />
      )}
      {zone.hover && (
        <div
          className="pointer-events-none absolute inset-x-1 z-10 rounded-lg bg-primary-subtle ring-1 ring-primary ring-inset"
          style={{
            top: (zone.hover.from / 60) * HOUR_PX,
            height: (zone.hover.length / 60) * HOUR_PX,
          }}
        />
      )}
      {props.placed.map((placed) =>
        placed.event.kind === "event" ? (
          <EventBlock
            key={eventKey(placed.event.event)}
            day={props.day}
            placed={{ ...placed, event: placed.event.event }}
            tone={props.tones.get(placed.event.event.calendarId) ?? ""}
            selected={props.picked === eventKey(placed.event.event)}
            handlers={props.handlers}
          />
        ) : (
          <TodoBlock
            key={placed.event.task.id}
            day={props.day}
            placed={{ ...placed, event: placed.event }}
            onTodo={props.handlers.onTodo}
            onOpenTodo={props.handlers.onOpenTodo}
          />
        ),
      )}
      <NowLine day={props.day} now={props.now} />
    </div>
  );
});

function NowLine({ day, now }: { day: Date; now: Date }) {
  const top = (minutesInto(startOfDayOf(now), now) / 60) * HOUR_PX;
  if (!sameDay(day, now)) {
    return (
      <div
        className="pointer-events-none absolute inset-x-0 border-t border-module-calendar/25"
        style={{ top }}
      />
    );
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top }}>
      <div className="absolute inset-x-0 -top-px border-t-2 border-module-calendar" />
      <div className="absolute -start-1 -top-1 size-2 rounded-full bg-module-calendar" />
    </div>
  );
}

function toneStyle(tone: string, event: CalendarEvent) {
  return {
    "--tone": tone,
    backgroundColor: `color-mix(in oklab, ${tone} 22%, var(--color-background))`,
    color: `color-mix(in oklab, ${tone} 40%, var(--color-foreground))`,
    ...(event.myResponse === "tentative"
      ? {
          backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${tone} 22%, transparent) 0 5px, transparent 5px 10px)`,
          backgroundColor: `color-mix(in oklab, ${tone} 10%, var(--color-background))`,
        }
      : {}),
  } as CSSProperties;
}

const AccentBar = () => (
  <span aria-hidden className="absolute inset-y-1 start-1 w-0.75 rounded-full bg-(--tone)" />
);

const answerLook = (event: CalendarEvent) =>
  cn(
    event.myResponse === "declined" && "opacity-45 line-through",
    event.myResponse === "needs_action" && "bg-background! ring-1 ring-(--tone) ring-inset",
  );

const EventBlock = memo(function EventBlock(
  props: PieceProps & { day: Date; placed: Placed<CalendarEvent> },
) {
  const { event, from, to, column, columns } = props.placed;
  const { selected, handlers } = props;
  const movable = ownEvent(event);
  return (
    <CanvasButton
      data-event={eventKey(event)}
      aria-pressed={selected}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-lg ps-3 pe-1.5 text-start text-xs",
        to - from < 30 ? "justify-center py-0" : "py-1",
        selected && "ring-2 ring-(--tone)",
        movable && "cursor-grab active:cursor-grabbing",
        answerLook(event),
      )}
      style={{
        ...toneStyle(props.tone, event),
        top: (from / 60) * HOUR_PX,
        height: Math.max(((to - from) / 60) * HOUR_PX - 2, 18),
        left: `calc(${(column / columns) * 100}% + 2px)`,
        width: `calc(${100 / columns}% - 4px)`,
      }}
      onClick={() => handlers.onSelect({ kind: "event", key: eventKey(event) })}
      onFocus={() => !selected && handlers.onSelect({ kind: "event", key: eventKey(event) })}
      onDoubleClick={() => handlers.onOpen(event)}
      draggable={movable}
      onDragStart={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        startDrag(
          e,
          { kind: "event", event, day: props.day },
          ((e.clientY - box.top) / HOUR_PX) * 60,
          leadOf(props.day, event.start, from),
        );
      }}
      onDragEnd={endDrag}
    >
      <AccentBar />
      <span className="truncate">
        <span className="font-medium">{event.title || "(No title)"}</span>
        {event.location && <span className="opacity-60"> {event.location}</span>}
      </span>
      {to - from >= 45 && (
        <span className="truncate opacity-70 tabular-nums">
          {time.format(new Date(event.start))}
        </span>
      )}
    </CanvasButton>
  );
});

type ChipPlace = Partial<Pick<ComponentProps<"button">, "className" | "style">>;

export const Chip = memo(function Chip(
  props: PieceProps & ChipPlace & { event: CalendarEvent; day?: Date; timed?: boolean },
) {
  const { event, selected, handlers } = props;
  return (
    <CanvasButton
      data-event={eventKey(event)}
      aria-pressed={selected}
      className={cn(
        "relative truncate rounded-md ps-3 pe-1.5 py-0.5 text-start text-xs font-medium",
        props.className,
        selected && "ring-2 ring-(--tone)",
        answerLook(event),
      )}
      style={{ ...toneStyle(props.tone, event), ...props.style }}
      draggable={ownEvent(event)}
      onDragStart={(e) => startDrag(e, { kind: "event", event, day: props.day })}
      onDragEnd={endDrag}
      onClick={() => handlers.onSelect({ kind: "event", key: eventKey(event) })}
      onFocus={() => !selected && handlers.onSelect({ kind: "event", key: eventKey(event) })}
      onDoubleClick={() => handlers.onOpen(event)}
    >
      <AccentBar />
      {props.timed && !event.allDay && (
        <span className="me-1 font-normal opacity-70 tabular-nums">
          {time.format(new Date(event.start))}
        </span>
      )}
      {event.title || "(No title)"}
    </CanvasButton>
  );
});
