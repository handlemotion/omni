import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/central";
import { StorageFrame } from "@/components/storage/storage-frame";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useCalendarEvents, useCalendars } from "@/hooks/use-calendar.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { warmCalendarWindow, type CalendarEvent } from "@/lib/calendar.ts";
import {
  dayKey,
  eventKey,
  nextHalfHour,
  shiftView,
  parseDayKey,
  type CalendarView,
  type Slot,
  windowOf,
} from "@/lib/calendar-grid.ts";
import { EventDialog } from "./event-dialog.tsx";
import { CalendarCrumbs } from "./calendar-crumbs.tsx";
import { useCalendarMenu } from "./calendar-menu.tsx";
import { EventPanel } from "./event-panel.tsx";
import { MonthGrid } from "./month-grid.tsx";
import { useMyTodos, useToggleTodo } from "./todo-list.tsx";
import { useCalendarKeys } from "./use-calendar-keys.ts";
import { WeekGrid, type Selection } from "./week-grid.tsx";

const UNITS = { week: "week", day: "day", month: "month" } as const;

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useNeighbors(view: CalendarView, at: number, loaded: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!loaded) return;
    for (const delta of [1, -1]) {
      const { from, to } = windowOf(view, shiftView(view, new Date(at), delta));
      void warmCalendarWindow(client, from, to);
    }
  }, [client, view, at, loaded]);
}

function Hinted(props: { label: string; keyName: string; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      {props.children}
      <Tooltip>
        <span className="flex items-center gap-2">
          {props.label}
          <span className="opacity-60">{props.keyName}</span>
        </span>
      </Tooltip>
    </TooltipTrigger>
  );
}

export type Editing = { event?: CalendarEvent; slot?: Slot } | null;

/** The calendar: a week or a day of every shown calendar, driven by keys or the pointer. */
export function CalendarPage(props: { date?: string; view?: CalendarView; calendar?: string }) {
  const view = props.view ?? "week";
  const anchor = parseDayKey(props.date);
  const at = anchor.getTime();
  const { days, from, to } = useMemo(() => windowOf(view, new Date(at)), [view, at]);
  const now = useNow();
  const calendars = useCalendars().data ?? [];
  const shown = useCalendarEvents(from, to);
  const all = shown.data;
  const events = useMemo(
    () =>
      props.calendar ? (all ?? []).filter((e) => e.calendarId === props.calendar) : (all ?? []),
    [all, props.calendar],
  );
  useNeighbors(view, at, shown.isFetched);
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
  const byKey = useMemo(() => new Map(events.map((e) => [eventKey(e), e])), [events]);
  const opened = panel ? byKey.get(panel) : undefined;

  const { move } = useCalendarKeys({
    events,
    selection,
    setSelection,
    open: (event) => setPanel(eventKey(event)),
    close: () => (panel ? setPanel(null) : setSelection(null)),
    create: (slot) => setEditing({ slot: slot ?? nextHalfHour(now) }),
    go: (delta) => go({ date: shiftView(view, anchor, delta) }),
    today: () => go({ date: new Date() }),
    view: (next) => go({ view: next }),
    paused: editing !== null,
  });
  const menu = useCalendarMenu({
    events,
    todos,
    onOpen: (event) => setPanel(eventKey(event)),
    onEdit: (event) => setEditing({ event }),
    onCreate: (slot) => setEditing({ slot }),
    onDay: view === "day" ? undefined : (day) => go({ date: day, view: "day" }),
    onTodo: toggleTodo,
  });

  return (
    <div className="flex h-svh min-h-0 min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <StorageFrame
          title={
            <CalendarCrumbs view={view} anchor={anchor} onView={(next) => go({ view: next })} />
          }
          actions={
            <>
              <div className="flex items-center gap-1">
                <Hinted label={`Previous ${UNITS[view]}`} keyName="←">
                  <Button
                    size="sq-sm"
                    intent="plain"
                    aria-label={`Previous ${UNITS[view]}`}
                    onPress={() => go({ date: shiftView(view, anchor, -1) })}
                  >
                    <IconChevronLeft />
                  </Button>
                </Hinted>
                <Hinted label="Go to today" keyName="T">
                  <Button size="sm" intent="outline" onPress={() => go({ date: new Date() })}>
                    Today
                  </Button>
                </Hinted>
                <Hinted label={`Next ${UNITS[view]}`} keyName="→">
                  <Button
                    size="sq-sm"
                    intent="plain"
                    aria-label={`Next ${UNITS[view]}`}
                    onPress={() => go({ date: shiftView(view, anchor, 1) })}
                  >
                    <IconChevronRight />
                  </Button>
                </Hinted>
              </div>
            </>
          }
        >
          <div className="flex min-h-0 flex-1" {...menu}>
            {view === "month" ? (
              <MonthGrid
                days={days}
                month={anchor.getMonth()}
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
                onDay={(day) => go({ date: day, view: "day" })}
              />
            ) : (
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
            )}
          </div>
          {editing && (
            <EventDialog
              calendars={calendars}
              event={editing.event}
              slot={editing.slot}
              calendarId={props.calendar}
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
