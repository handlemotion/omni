import { cn } from "cn";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { IconPlus } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { CanvasButton } from "@/components/ui/canvas-button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import type { CalendarEvent, CalendarItem } from "@/lib/calendar.ts";
import { calendarTone } from "@/lib/calendar.ts";
import { dayOf, type CrmTask } from "@/lib/crm-tasks.ts";
import {
  allDayOn,
  dayKey,
  eventKey,
  HOUR_PX,
  minutesInto,
  placeDay,
  sameDay,
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
  todos?: readonly CrmTask[];
  onTodo?: (task: CrmTask, done: boolean) => void;
  /** A new event at the selection, from the grid's corner. */
  onNew?: () => void;
}

/** Whether the member may move it: an event made in Omni that their inbox organizes. */
export const ownEvent = (event: CalendarEvent) => event.source === "omni" && event.organizing;

const snap = (minutes: number) => Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

/** The week or the day: an all-day strip, then the hours with each day's events in place. */
export function WeekGrid(props: WeekGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
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
        {props.days.map((day) => (
          <div
            key={day.getTime()}
            data-all-day={dayKey(day)}
            className={cn(
              "flex min-h-8 flex-col gap-0.5 border-l border-calendar-line p-1",
              weekend(day) && "bg-hover",
            )}
          >
            {allDayOn(day, props.events).map((event) => (
              <EventChip key={eventKey(event)} event={event} {...props} />
            ))}
            {props.todos
              ?.filter((task) => task.dueAt && dayOf(task.dueAt) === dayKey(day))
              .map((task) => (
                <TodoChip key={task.id} task={task} onTodo={props.onTodo} />
              ))}
          </div>
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
          {props.days.map((day) => (
            <DayColumn key={day.getTime()} day={day} {...props} />
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

function DayColumn(props: WeekGridProps & { day: Date }) {
  const [sweep, setSweep] = useState<{ from: number; to: number } | null>(null);
  const minutesAt = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return ((event.clientY - box.top) / HOUR_PX) * 60;
  };
  const chosen =
    props.selection?.kind === "slot" && sameDay(props.selection.slot.start, props.day)
      ? props.selection.slot
      : null;
  return (
    <div
      role="presentation"
      data-day={dayKey(props.day)}
      className={cn("relative border-l border-calendar-line", weekend(props.day) && "bg-hover")}
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
        props.onSelect({
          kind: "slot",
          slot: slotAt(props.day, sweep.from, sweep.to - sweep.from),
        });
        setSweep(null);
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget) return;
        props.onCreate(slotAt(props.day, snap(minutesAt(event) - SLOT_MINUTES / 2)));
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
      {placeDay(props.day, props.events).map((placed) => (
        <EventBlock key={eventKey(placed.event)} placed={placed} {...props} />
      ))}
      <NowLine day={props.day} now={props.now} />
    </div>
  );
}

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

function toneStyle(props: WeekGridProps, event: CalendarEvent) {
  const tone = calendarTone(props.calendars, event.calendarId);
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

function EventBlock(props: WeekGridProps & { placed: ReturnType<typeof placeDay>[number] }) {
  const { event, from, to, column, columns } = props.placed;
  const [drag, setDrag] = useState<{ y: number; moved: number } | null>(null);
  const selected = props.selection?.kind === "event" && props.selection.key === eventKey(event);
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
        ...toneStyle(props, event),
        top: ((from + (drag?.moved ?? 0)) / 60) * HOUR_PX,
        height: Math.max(((to - from) / 60) * HOUR_PX - 2, 18),
        left: `calc(${(column / columns) * 100}% + 2px)`,
        width: `calc(${100 / columns}% - 4px)`,
      }}
      onClick={() => props.onSelect({ kind: "event", key: eventKey(event) })}
      onFocus={() => !selected && props.onSelect({ kind: "event", key: eventKey(event) })}
      onDoubleClick={() => props.onOpen(event)}
      onPointerDown={(e) => {
        if (!movable || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ y: e.clientY, moved: 0 });
      }}
      onPointerMove={(e) =>
        drag && setDrag({ ...drag, moved: snap(((e.clientY - drag.y) / HOUR_PX) * 60) })
      }
      onPointerUp={() => {
        if (drag?.moved) props.onMove(event, drag.moved);
        setDrag(null);
      }}
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
}

/** An event as one line: all-day ones on the week's top row, every one in a month's day. */
export function EventChip(props: WeekGridProps & { event: CalendarEvent; timed?: boolean }) {
  const { event } = props;
  const selected = props.selection?.kind === "event" && props.selection.key === eventKey(event);
  return (
    <CanvasButton
      data-event={eventKey(event)}
      aria-pressed={selected}
      className={cn(
        "relative truncate rounded-md ps-3 pe-1.5 py-0.5 text-start text-xs font-medium",
        selected && "ring-2 ring-(--tone)",
        answerLook(event),
      )}
      style={toneStyle(props, event)}
      onClick={() => props.onSelect({ kind: "event", key: eventKey(event) })}
      onFocus={() => !selected && props.onSelect({ kind: "event", key: eventKey(event) })}
      onDoubleClick={() => props.onOpen(event)}
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
}

/** A dated to-do on its day: its check, then its title. */
export function TodoChip({ task, onTodo }: { task: CrmTask; onTodo?: WeekGridProps["onTodo"] }) {
  const done = !!task.completedAt;
  return (
    <CheckboxField
      aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      isSelected={done}
      onChange={(next: boolean) => onTodo?.(task, next)}
      className="min-w-0 overflow-hidden rounded-md px-1.5 py-0.5 hover:bg-hover **:data-[slot=indicator]:rounded-full **:data-[slot=control-label]:min-w-0"
    >
      <Checkbox>
        <span
          className={cn(
            "block min-w-0 truncate text-xs",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
      </Checkbox>
    </CheckboxField>
  );
}
