import { cn } from "cn";
import { CanvasButton } from "@/components/ui/canvas-button";
import type { CalendarEvent } from "@/lib/calendar.ts";
import { addDays, allDayOn, dayKey, eventKey, sameDay } from "@/lib/calendar-grid.ts";
import { dayOf } from "@/lib/crm-tasks.ts";
import { useDropZone } from "./drop-zone.ts";
import { TodoChip } from "./todo-block.tsx";
import { EventChip, type WeekGridProps } from "./week-grid.tsx";

const SHOWN = 3;
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });

const timedOn = (day: Date, events: readonly CalendarEvent[]) => {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  return events
    .filter((e) => !e.allDay && Date.parse(e.start) < end && Date.parse(e.end) > start)
    .toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
};

/**
 * Six weeks around a month, each day with its first events and dated to-dos; a day's number
 * opens it, and so does its "more" when it holds more than fit.
 */
export function MonthGrid(props: WeekGridProps & { month: number; onDay: (day: Date) => void }) {
  const weeks = Array.from({ length: props.days.length / 7 }, (_, i) =>
    props.days.slice(i * 7, i * 7 + 7),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b">
        {weeks[0]?.map((day) => (
          <span key={day.getTime()} className="py-2 text-center text-sm text-muted-foreground">
            {weekday.format(day)}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr">
        {weeks.map((week) => (
          <div key={week[0]?.getTime()} className="grid min-h-0 grid-cols-7 first:*:border-t-0">
            {week.map((day) => (
              <MonthDay key={day.getTime()} day={day} {...props} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthDay(props: WeekGridProps & { day: Date; month: number; onDay: (day: Date) => void }) {
  const { day } = props;
  const events = [...allDayOn(day, props.events), ...timedOn(day, props.events)];
  const todos = (props.todos ?? []).filter(
    (task) => task.dueAt && dayOf(task.dueAt) === dayKey(day),
  );
  const items = events.length + todos.length;
  const more = Math.max(0, items - SHOWN);
  const today = sameDay(day, props.now);
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  const zone = useDropZone(day, false, props.onDrop);
  return (
    <div
      data-month-day={dayKey(day)}
      {...zone.handlers}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-t border-l border-calendar-line p-1 first:border-l-0",
        weekend && "bg-hover",
        zone.over && "bg-primary-subtle",
      )}
    >
      <CanvasButton
        aria-label={`Open ${day.toDateString()}`}
        onClick={() => props.onDay(day)}
        className={cn(
          "mb-1 grid h-5 min-w-5 place-items-center self-start rounded-md px-1 text-xs tabular-nums",
          day.getMonth() === props.month ? "text-foreground" : "text-subtle-foreground",
          today && "bg-module-calendar font-medium text-primary-foreground",
        )}
      >
        {day.getDate()}
      </CanvasButton>
      {events.slice(0, SHOWN).map((event) => (
        <EventChip key={eventKey(event)} event={event} timed {...props} />
      ))}
      {todos.slice(0, Math.max(0, SHOWN - events.length)).map((task) => (
        <TodoChip key={task.id} task={task} onTodo={props.onTodo} onOpenTodo={props.onOpenTodo} />
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
}
