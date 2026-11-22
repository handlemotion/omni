import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/central";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useCalendarEvents, useCalendars } from "@/hooks/use-calendar.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import type { CalendarEvent } from "@/lib/calendar.ts";
import {
  addDays,
  daysOf,
  dayKey,
  eventKey,
  nextHalfHour,
  parseDayKey,
  type CalendarView,
  type Slot,
} from "@/lib/calendar-grid.ts";
import { EventDialog } from "./event-dialog.tsx";
import { EventPanel } from "./event-panel.tsx";
import { useMyTodos, useToggleTodo } from "./todo-list.tsx";
import { useCalendarKeys } from "./use-calendar-keys.ts";
import { WeekGrid, type Selection } from "./week-grid.tsx";

const VIEWS = [
  { id: "week", name: "Week" },
  { id: "day", name: "Day" },
];

const monthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function isoWeek(date: Date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export type Editing = { event?: CalendarEvent; slot?: Slot } | null;

/** The calendar: a week or a day of every shown calendar, driven by keys or the pointer. */
export function CalendarPage(props: { date?: string; view?: CalendarView; calendar?: string }) {
  const view = props.view ?? "week";
  const anchor = parseDayKey(props.date);
  const days = daysOf(view, anchor);
  const from = days[0] ?? anchor;
  const to = addDays(days.at(-1) ?? anchor, 1);
  const now = useNow();
  const calendars = useCalendars().data ?? [];
  const all = useCalendarEvents(from, to).data ?? [];
  const events = props.calendar ? all.filter((e) => e.calendarId === props.calendar) : all;
  const todos = useMyTodos();
  const toggleTodo = useToggleTodo();
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const go = (next: { date?: Date; view?: CalendarView }) =>
    void navigate({
      to: "/$workspace/calendar",
      params: { workspace },
      search: (prev) => ({ ...prev, date: dayKey(next.date ?? anchor), view: next.view ?? view }),
      replace: true,
    });
  const step = view === "week" ? 7 : 1;
  const byKey = useMemo(() => new Map(events.map((e) => [eventKey(e), e])), [events]);
  const opened = panel ? byKey.get(panel) : undefined;

  const { move } = useCalendarKeys({
    events,
    selection,
    setSelection,
    open: (event) => setPanel(eventKey(event)),
    close: () => (panel ? setPanel(null) : setSelection(null)),
    create: (slot) => setEditing({ slot: slot ?? nextHalfHour(now) }),
    go: (delta) => go({ date: addDays(anchor, delta * step) }),
    today: () => go({ date: new Date() }),
    view: (next) => go({ view: next }),
    paused: editing !== null,
  });

  return (
    <div className="flex h-svh min-h-0 min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <StorageFrame
          title={
            <Heading className="flex items-baseline gap-2 truncate text-md">
              {monthYear.format(from)}
              <span className="text-xs text-muted-foreground tabular-nums">W{isoWeek(from)}</span>
            </Heading>
          }
          actions={
            <>
              <Button
                size="sq-sm"
                intent="plain"
                aria-label="Previous"
                onPress={() => go({ date: addDays(anchor, -step) })}
              >
                <IconChevronLeft />
              </Button>
              <Button size="sm" intent="plain" onPress={() => go({ date: new Date() })}>
                Today
              </Button>
              <Button
                size="sq-sm"
                intent="plain"
                aria-label="Next"
                onPress={() => go({ date: addDays(anchor, step) })}
              >
                <IconChevronRight />
              </Button>
              <Select
                aria-label="View"
                value={view}
                onChange={(next) => {
                  if (next === "week" || next === "day") go({ view: next });
                }}
              >
                <SelectTrigger className="ms-1 w-24" />
                <SelectContent items={VIEWS}>
                  {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
                </SelectContent>
              </Select>
            </>
          }
        >
          <div className="flex min-h-0 flex-1">
            <WeekGrid
              days={days}
              events={events}
              calendars={calendars}
              selection={selection}
              now={now}
              onSelect={setSelection}
              onOpen={(event) => setPanel(eventKey(event))}
              onCreate={(slot) => setEditing({ slot })}
              onMove={(event, minutes) => move(event, minutes)}
              todos={todos}
              onTodo={toggleTodo}
              onNew={() =>
                setEditing({
                  slot: selection?.kind === "slot" ? selection.slot : nextHalfHour(now),
                })
              }
            />
          </div>
          {editing && (
            <EventDialog
              calendars={calendars}
              event={editing.event}
              slot={editing.slot}
              onClose={() => setEditing(null)}
            />
          )}
        </StorageFrame>
      </div>
      {opened && (
        <EventPanel
          event={opened}
          calendarAddress={calendars.find((c) => c.id === opened.calendarId)?.address}
          onClose={() => setPanel(null)}
          onEdit={() => setEditing({ event: opened })}
        />
      )}
    </div>
  );
}
