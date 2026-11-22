import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { useCalendarWrites } from "@/hooks/use-calendar.ts";
import { ApiError } from "@/lib/api.ts";
import type { CalendarEvent, CalendarItem } from "@/lib/calendar.ts";
import { addDays, dayKey, parseDayKey, type Slot } from "@/lib/calendar-grid.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

function at(day: string, time: string) {
  const [h = 0, m = 0] = time.split(":").map(Number);
  const date = parseDayKey(day);
  date.setHours(h, m, 0, 0);
  return date;
}

const midnightUtc = (day: string) => `${day}T00:00:00.000Z`;

interface Draft {
  calendarId: string;
  title: string;
  day: string;
  span: number;
  start: string;
  end: string;
  allDay: boolean;
  guests: string;
  location: string;
  conferenceUrl: string;
  description: string;
}

const daysBetween = (from: string, to: string) =>
  Math.round((parseDayKey(to).getTime() - parseDayKey(from).getTime()) / 86_400_000);

function times(start: Date, end: Date) {
  const day = dayKey(start);
  return { day, span: daysBetween(day, dayKey(end)), start: hhmm(start), end: hhmm(end) };
}

const defaultCalendar = (props: EventDialogProps) =>
  (
    props.calendars.find((c) => c.id === props.calendarId) ??
    props.calendars.find((c) => !c.hidden) ??
    props.calendars[0]
  )?.id ?? "";

function newDraft(props: EventDialogProps) {
  const start = props.slot?.start ?? new Date();
  const end = props.slot?.end ?? new Date(start.getTime() + 1_800_000);
  const draft: Draft = {
    calendarId: "",
    title: "",
    ...times(start, end),
    allDay: false,
    guests: "",
    location: "",
    conferenceUrl: "",
    description: "",
  };
  return draft;
}

function draftOf(props: EventDialogProps) {
  const { event } = props;
  if (!event) return newDraft(props);
  const draft: Draft = {
    calendarId: event.calendarId,
    title: event.title,
    ...times(new Date(event.start), new Date(event.end)),
    ...(event.allDay && event.startDay && event.endDay
      ? { day: event.startDay, span: daysBetween(event.startDay, event.endDay) }
      : {}),
    allDay: event.allDay,
    guests: event.attendees
      .filter((a) => a.role !== "chair")
      .map((a) => a.address)
      .join(", "),
    location: event.location ?? "",
    conferenceUrl: event.conferenceUrl ?? "",
    description: event.description ?? "",
  };
  return draft;
}

function bodyOf(draft: Draft) {
  const guests = draft.guests
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
  const times = draft.allDay
    ? {
        start: midnightUtc(draft.day),
        end: midnightUtc(dayKey(addDays(parseDayKey(draft.day), Math.max(1, draft.span)))),
      }
    : {
        start: at(draft.day, draft.start).toISOString(),
        end: at(dayKey(addDays(parseDayKey(draft.day), draft.span)), draft.end).toISOString(),
      };
  return {
    title: draft.title.trim(),
    ...times,
    allDay: draft.allDay,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    location: draft.location.trim() || null,
    conferenceUrl: draft.conferenceUrl.trim() || null,
    description: draft.description.trim() || null,
    guests,
  };
}

interface EventDialogProps {
  calendars: readonly CalendarItem[];
  /** Editing this event; a new one otherwise. */
  event?: CalendarEvent;
  /** Where a new one starts. */
  slot?: Slot;
  /** The calendar a new one goes on: the one the grid shows alone, if any. */
  calendarId?: string;
  onClose: () => void;
}

/** Makes an event, or changes one the member's inbox organizes. Guests get mail either way. */
export function EventDialog(props: EventDialogProps) {
  const [draft, setDraft] = useState(() => draftOf(props));
  const set =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const { create, update } = useCalendarWrites();
  const saving = create.isPending || update.isPending;
  const calendarId = draft.calendarId || defaultCalendar(props);
  const failed = (error: unknown) =>
    appToast.error(
      error instanceof ApiError && error.param
        ? `Check the ${error.param}`
        : "The event was not saved",
    );
  const submit = () => {
    const body = bodyOf(draft);
    if (props.event) {
      update.mutate(
        { id: props.event.id, change: body },
        { onSuccess: props.onClose, onError: failed },
      );
    } else {
      create.mutate({ calendarId, ...body }, { onSuccess: props.onClose, onError: failed });
    }
  };
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.event ? "Edit event" : "New event"}
      action={props.event ? "Save" : "Create"}
      disabled={!draft.title.trim() || !calendarId}
      saving={saving}
      onSubmit={submit}
    >
      <TextField isRequired autoFocus maxLength={500} value={draft.title} onChange={set("title")}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
      {!props.event && props.calendars.length > 1 && (
        <Select
          aria-label="Calendar"
          value={calendarId}
          onChange={(id) => set("calendarId")(String(id))}
        >
          <Label>Calendar</Label>
          <SelectTrigger />
          <SelectContent items={props.calendars.map((c) => ({ id: c.id, name: c.address }))}>
            {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
          </SelectContent>
        </Select>
      )}
      <div className="grid grid-cols-3 gap-3">
        <TextField type="date" value={draft.day} onChange={set("day")}>
          <Label>Day</Label>
          <Input />
        </TextField>
        {!draft.allDay && (
          <>
            <TextField type="time" value={draft.start} onChange={set("start")}>
              <Label>Start</Label>
              <Input />
            </TextField>
            <TextField type="time" value={draft.end} onChange={set("end")}>
              <Label>End</Label>
              <Input />
            </TextField>
          </>
        )}
      </div>
      <CheckboxField
        isSelected={draft.allDay}
        onChange={(allDay: boolean) =>
          setDraft((d) => ({ ...d, allDay, span: !allDay && d.allDay ? 0 : d.span }))
        }
      >
        <Checkbox>
          <Label>All day</Label>
        </Checkbox>
      </CheckboxField>
      <TextField value={draft.guests} onChange={set("guests")}>
        <Label>Guests</Label>
        <Input autoComplete="off" />
      </TextField>
      <div className="grid grid-cols-2 gap-3">
        <TextField maxLength={500} value={draft.location} onChange={set("location")}>
          <Label>Location</Label>
          <Input autoComplete="off" />
        </TextField>
        <TextField type="url" value={draft.conferenceUrl} onChange={set("conferenceUrl")}>
          <Label>Video link</Label>
          <Input autoComplete="off" />
        </TextField>
      </div>
      <TextField maxLength={20_000} value={draft.description} onChange={set("description")}>
        <Label>Description</Label>
        <Textarea rows={3} />
      </TextField>
    </SettingsFormDialog>
  );
}
