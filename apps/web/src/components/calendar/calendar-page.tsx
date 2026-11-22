import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/central";
import { StorageFrame } from "@/components/storage/storage-frame";
import { TaskPanel, useOpenTask } from "@/components/tasks/task-panel.tsx";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useCalendars, useCalendarWindows } from "@/hooks/use-calendar.ts";
import { useWheelStep } from "@/hooks/use-wheel-step.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { warmCalendarWindow, type CalendarEvent } from "@/lib/calendar.ts";
import type { Todo } from "@/lib/calendar-tasks.ts";
import {
  DEFAULT_VIEW,
  dayKey,
  eventKey,
  nextHalfHour,
  shiftView,
  parseDayKey,
  type CalendarView,
  type Slot,
  windowOf,
} from "@/lib/calendar-grid.ts";
import { BookingShare } from "./booking-share.tsx";
import { EventDialog } from "./event-dialog.tsx";
import { CalendarCrumbs } from "./calendar-crumbs.tsx";
import { useCalendarMenu } from "./calendar-menu.tsx";
import { EventPanel } from "./event-panel.tsx";
import { useCalendarDrop } from "./use-calendar-drop.ts";
import { useMonthSpan } from "./month-span.ts";
import { MonthGrid } from "./month-grid.tsx";
import { useMyTodos, useToggleTodo } from "./todo-list.tsx";
import { useCalendarKeys } from "./use-calendar-keys.ts";
import { WeekGrid, type Selection } from "./week-grid.tsx";

const SYNC_MS = 300;

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
    if (!loaded || view === "month") return;
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
export function CalendarPage(props: {
  date?: string;
  view?: CalendarView;
  calendar?: string;
  task?: string;
}) {
  const view = props.view ?? DEFAULT_VIEW;
  const anchor = parseDayKey(props.date);
  const at = anchor.getTime();
  const span = useMonthSpan(anchor);
  const week = useMemo(() => windowOf(view, new Date(at)), [view, at]);
  const { days } = view === "month" ? span : week;
  const windows = useMemo(
    () => (view === "month" ? span.windows : [week]),
    [view, span.windows, week],
  );
  const now = useNow();
  const calendars = useCalendars().data ?? [];
  const shown = useCalendarWindows(windows);
  const all = shown.data;
  const events = useMemo(
    () =>
      props.calendar ? (all ?? []).filter((e) => e.calendarId === props.calendar) : (all ?? []),
    [all, props.calendar],
  );
  const [scrolled, setScrolled] = useState<{ first: Date; under: string } | null>(null);
  const here = view === "month" && scrolled?.under === dayKey(anchor) ? scrolled.first : anchor;
  const hereAt = here.getTime();
  const inView = useMemo(() => {
    if (view !== "month") return events;
    const { from, to } = windowOf("month", new Date(hereAt));
    return events.filter(
      (e) => Date.parse(e.start) < to.getTime() && Date.parse(e.end) > from.getTime(),
    );
  }, [view, hereAt, events]);
  useNeighbors(view, at, shown.isFetched);
  const todos = useMyTodos();
  const toggleTodo = useToggleTodo();
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const sync = useRef(0);
  useEffect(() => () => window.clearTimeout(sync.current), []);
  const go = (next: { date?: Date; view?: CalendarView }) => {
    window.clearTimeout(sync.current);
    void navigate({
      to: "/$workspace/calendar",
      params: { workspace },
      search: (prev) => ({ ...prev, date: dayKey(next.date ?? here), view: next.view ?? view }),
      replace: true,
      resetScroll: false,
    });
  };
  const written = useRef<string[]>([]);
  const scrolledTo = (first: Date) => {
    setScrolled({ first, under: dayKey(anchor) });
    window.clearTimeout(sync.current);
    sync.current = window.setTimeout(() => {
      if (dayKey(first) === lastAnchor.current) return;
      written.current.push(dayKey(first));
      go({ date: first });
    }, SYNC_MS);
  };
  const ownWrite = useCallback((key: string) => {
    const at = written.current.indexOf(key);
    if (at < 0) return false;
    written.current.splice(0, at + 1);
    return true;
  }, []);
  const anchorKey = dayKey(anchor);
  const lastAnchor = useRef(anchorKey);
  if (lastAnchor.current !== anchorKey) {
    lastAnchor.current = anchorKey;
    if (!written.current.includes(anchorKey)) window.clearTimeout(sync.current);
  }
  const [aimed, setAimed] = useState({ at: "", count: 0 });
  const step = (date: Date) => {
    setAimed((now) => ({ at: dayKey(date), count: now.count + 1 }));
    go({ date });
  };
  const openTask = useOpenTask();
  const router = useRouter();
  const openTodo = (task: Todo) => void router.history.push(openTask.href(task.id));
  const [taskShown, setTaskShown] = useState(props.task);
  if (taskShown !== props.task) {
    setTaskShown(props.task);
    if (props.task) {
      setPanel(null);
      setSelection(null);
    }
  }
  const byKey = useMemo(() => new Map(events.map((e) => [eventKey(e), e])), [events]);
  const opened = panel ? byKey.get(panel) : undefined;

  const { move } = useCalendarKeys({
    events,
    stepping: inView,
    selection,
    setSelection,
    open: (event) => {
      if (props.task) openTask.close();
      setPanel(eventKey(event));
    },
    close: () => (panel ? setPanel(null) : setSelection(null)),
    create: (slot) => setEditing({ slot: slot ?? nextHalfHour(now) }),
    go: (delta) => step(shiftView(view, here, delta)),
    today: () => step(new Date()),
    view: (next) => go({ view: next }),
    paused: editing !== null,
  });
  const dropOn = useCalendarDrop(move);
  const menu = useCalendarMenu({
    events,
    todos,
    onOpen: (event) => setPanel(eventKey(event)),
    onEdit: (event) => setEditing({ event }),
    onCreate: (slot) => setEditing({ slot }),
    onDay: view === "day" ? undefined : (day) => go({ date: day, view: "day" }),
    onTodo: toggleTodo,
    onOpenTodo: (task) => openTodo(task),
  });
  const grid = useRef<HTMLDivElement>(null);
  useWheelStep(
    grid,
    "x",
    (delta) => go({ date: shiftView(view, anchor, delta) }),
    view !== "month",
  );

  return (
    <div className="flex h-svh min-h-0 min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <StorageFrame
          title={<CalendarCrumbs view={view} anchor={here} onView={(next) => go({ view: next })} />}
          actions={
            <>
              <div className="flex items-center gap-1">
                <Hinted label={`Previous ${UNITS[view]}`} keyName="←">
                  <Button
                    size="sq-sm"
                    intent="outline"
                    aria-label={`Previous ${UNITS[view]}`}
                    onPress={() => step(shiftView(view, here, -1))}
                  >
                    <IconChevronLeft />
                  </Button>
                </Hinted>
                <Hinted label="Go to today" keyName="T">
                  <Button size="sm" intent="outline" onPress={() => step(new Date())}>
                    Today
                  </Button>
                </Hinted>
                <Hinted label={`Next ${UNITS[view]}`} keyName="→">
                  <Button
                    size="sq-sm"
                    intent="outline"
                    aria-label={`Next ${UNITS[view]}`}
                    onPress={() => step(shiftView(view, here, 1))}
                  >
                    <IconChevronRight />
                  </Button>
                </Hinted>
              </div>
              <BookingShare calendars={calendars} />
            </>
          }
        >
          <div ref={grid} className="flex min-h-0 flex-1" {...menu}>
            {view === "month" ? (
              <MonthGrid
                days={days}
                anchor={anchor}
                shown={here}
                aimed={aimed}
                onMonth={scrolledTo}
                ownWrite={ownWrite}
                onExtend={span.extend}
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
                onDrop={dropOn}
                onOpenTodo={openTodo}
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
                onDrop={dropOn}
                onOpenTodo={openTodo}
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
      {props.task && !opened && (
        <div data-calendar-keys="off" className="flex w-[25rem] shrink-0">
          <TaskPanel id={props.task} onClose={openTask.close} from="calendar" />
        </div>
      )}
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
