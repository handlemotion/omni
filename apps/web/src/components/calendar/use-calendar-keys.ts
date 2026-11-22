import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { appToast } from "@/components/ui/toast";
import { useCalendarWrites } from "@/hooks/use-calendar.ts";
import {
  eventTimesNow,
  placeEvent,
  type CalendarAnswer,
  type CalendarEvent,
} from "@/lib/calendar.ts";
import { eventKey, SLOT_MINUTES, type CalendarView, type Slot } from "@/lib/calendar-grid.ts";
import { answerable } from "./event-panel.tsx";
import { ownEvent, type Selection } from "./week-grid.tsx";

const MINUTE = 60_000;
const EDITABLE =
  "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']";
const ANSWER_KEYS: Record<string, CalendarAnswer> = {
  y: "accepted",
  n: "declined",
  m: "tentative",
};

interface Keys {
  events: readonly CalendarEvent[];
  selection: Selection;
  setSelection: (selection: Selection) => void;
  open: (event: CalendarEvent) => void;
  close: () => void;
  create: (slot?: Slot) => void;
  go: (delta: number) => void;
  today: () => void;
  view: (view: CalendarView) => void;
  /** While a dialog is up, the calendar takes no keys. */
  paused: boolean;
}

const shifted = (slot: Slot, start: number, end: number) =>
  ({
    start: new Date(slot.start.getTime() + start * MINUTE),
    end: new Date(slot.end.getTime() + end * MINUTE),
  }) satisfies Slot;

/**
 * The calendar's keys (`docs/spec/calendar.md`, "Keys"). They live here rather than in the app's
 * shortcut table because `Shift` changes what an arrow does, which the table cannot tell apart.
 */
export function useCalendarKeys(keys: Keys) {
  const { answer, update, remove } = useCalendarWrites();
  const client = useQueryClient();
  const move = (event: CalendarEvent, start: number, end = start) => {
    const now = eventTimesNow(client, event.id) ?? event;
    const change = {
      start: new Date(Date.parse(now.start) + start * MINUTE).toISOString(),
      end: new Date(Date.parse(now.end) + end * MINUTE).toISOString(),
    };
    placeEvent(client, event.id, change.start, change.end);
    update.mutate(
      { id: event.id, change },
      { onError: () => appToast.error("The event was not moved") },
    );
  };
  const latest = useRef({ keys, move, answer, remove });
  latest.current = { keys, move, answer, remove };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { keys: k } = latest.current;
      if (k.paused || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(EDITABLE)) return;
      if (handle(event.key, event.shiftKey, latest.current)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { move };
}

type Latest = {
  keys: Keys;
  move: (event: CalendarEvent, start: number, end?: number) => void;
  answer: ReturnType<typeof useCalendarWrites>["answer"];
  remove: ReturnType<typeof useCalendarWrites>["remove"];
};

function selectedEvent(keys: Keys) {
  const selection = keys.selection;
  return selection?.kind === "event"
    ? keys.events.find((e) => eventKey(e) === selection.key)
    : undefined;
}

function handle(key: string, shift: boolean, latest: Latest) {
  const { keys } = latest;
  const navigation: Record<string, () => void> = {
    ArrowLeft: () => keys.go(-1),
    ArrowRight: () => keys.go(1),
    t: keys.today,
    w: () => keys.view("week"),
    d: () => keys.view("day"),
    c: () => keys.create(keys.selection?.kind === "slot" ? keys.selection.slot : undefined),
    Escape: keys.close,
    "]": () => step(keys, 1),
    "[": () => step(keys, -1),
  };
  const run = navigation[key];
  if (run) {
    run();
    return true;
  }
  if (key === "ArrowUp" || key === "ArrowDown")
    return nudge(key === "ArrowUp" ? -1 : 1, shift, latest);
  return onEvent(key, latest);
}

function step(keys: Keys, direction: 1 | -1) {
  const ordered = keys.events.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const current = selectedEvent(keys);
  const index = current ? ordered.indexOf(current) : direction > 0 ? -1 : ordered.length;
  const next = ordered[index + direction];
  if (next) keys.setSelection({ kind: "event", key: eventKey(next) });
}

function nudge(direction: 1 | -1, shift: boolean, latest: Latest) {
  const { keys } = latest;
  const by = direction * SLOT_MINUTES;
  if (keys.selection?.kind === "slot") {
    const slot = keys.selection.slot;
    const next = shift ? shifted(slot, 0, by) : shifted(slot, by, by);
    if (next.end.getTime() - next.start.getTime() < SLOT_MINUTES * MINUTE) return true;
    keys.setSelection({ kind: "slot", slot: next });
    return true;
  }
  const event = selectedEvent(keys);
  if (!event || !ownEvent(event) || event.allDay) return false;
  if (shift) {
    if (Date.parse(event.end) + by * MINUTE - Date.parse(event.start) < SLOT_MINUTES * MINUTE)
      return true;
    latest.move(event, 0, by);
  } else latest.move(event, by);
  return true;
}

function onEvent(key: string, latest: Latest) {
  const event = selectedEvent(latest.keys);
  if (!event) return false;
  const response = ANSWER_KEYS[key];
  if (response) {
    if (!answerable(event)) return false;
    latest.answer.mutate(
      { id: event.id, response },
      { onError: () => appToast.error("The answer was not sent") },
    );
    return true;
  }
  if (key === "Enter") {
    latest.keys.open(event);
    return true;
  }
  if (key === "j" && event.conferenceUrl) {
    window.open(event.conferenceUrl, "_blank", "noopener");
    return true;
  }
  if (key === "Backspace" || key === "Delete") return erase(event, latest);
  return false;
}

function erase(event: CalendarEvent, latest: Latest) {
  if (answerable(event)) {
    latest.answer.mutate({ id: event.id, response: "declined" });
    return true;
  }
  if (!ownEvent(event)) return false;
  const guests = event.attendees.filter((a) => a.role !== "chair");
  if (guests.length > 0) latest.keys.open(event);
  else {
    latest.remove.mutate(event.id, { onError: () => appToast.error("The event was not deleted") });
    latest.keys.setSelection(null);
  }
  return true;
}
