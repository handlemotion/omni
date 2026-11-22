import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError } from "@/lib/api.ts";
import type { BookingLink, NewBookingLink } from "@/lib/booking.ts";
import type { CalendarItem } from "@/lib/calendar.ts";

const DURATIONS = [15, 30, 45, 60, 90];
const WEEKDAYS = [
  { id: 1, label: "M", name: "Monday" },
  { id: 2, label: "T", name: "Tuesday" },
  { id: 3, label: "W", name: "Wednesday" },
  { id: 4, label: "T", name: "Thursday" },
  { id: 5, label: "F", name: "Friday" },
  { id: 6, label: "S", name: "Saturday" },
  { id: 0, label: "S", name: "Sunday" },
];

const minutesOf = (time: string) => {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
};

interface Draft {
  title: string;
  calendarId: string;
  durationMinutes: number;
  start: string;
  end: string;
  weekdays: number[];
}

/** Makes a booking link: a page where someone picks a free slot on the member's calendar. */
export function BookingDialog(props: {
  calendars: readonly CalendarItem[];
  saving: boolean;
  onCreate: (link: NewBookingLink, done: (link: BookingLink) => void) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => ({
    title: "",
    calendarId: (props.calendars.find((c) => !c.hidden) ?? props.calendars[0])?.id ?? "",
    durationMinutes: 30,
    start: "09:00",
    end: "17:00",
    weekdays: [1, 2, 3, 4, 5],
  }));
  const set =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const startMinute = minutesOf(draft.start);
  const endMinute = minutesOf(draft.end) || 1440;
  const valid =
    draft.title.trim() !== "" &&
    draft.calendarId !== "" &&
    draft.weekdays.length > 0 &&
    startMinute + draft.durationMinutes <= endMinute;
  const submit = () =>
    props.onCreate(
      {
        calendarId: draft.calendarId,
        title: draft.title.trim(),
        durationMinutes: draft.durationMinutes,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        weekdays: draft.weekdays,
        startMinute,
        endMinute,
      },
      props.onClose,
    );
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New booking link"
      action="Create link"
      disabled={!valid}
      saving={props.saving}
      onSubmit={submit}
    >
      <TextField isRequired autoFocus maxLength={200} value={draft.title} onChange={set("title")}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
      <div className="grid grid-cols-2 gap-3">
        <Select
          aria-label="Length"
          value={draft.durationMinutes}
          onChange={(value) => set("durationMinutes")(Number(value))}
        >
          <Label>Length</Label>
          <SelectTrigger />
          <SelectContent items={DURATIONS.map((m) => ({ id: m, name: `${m} min` }))}>
            {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
          </SelectContent>
        </Select>
        {props.calendars.length > 1 && (
          <Select
            aria-label="Calendar"
            value={draft.calendarId}
            onChange={(id) => set("calendarId")(String(id))}
          >
            <Label>Calendar</Label>
            <SelectTrigger />
            <SelectContent items={props.calendars.map((c) => ({ id: c.id, name: c.address }))}>
              {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField type="time" value={draft.start} onChange={set("start")}>
          <Label>From</Label>
          <Input />
        </TextField>
        <TextField type="time" value={draft.end} onChange={set("end")}>
          <Label>To</Label>
          <Input />
        </TextField>
      </div>
      <div className="flex flex-col gap-2">
        <Label id="booking-days">Days</Label>
        <ToggleGroup
          aria-labelledby="booking-days"
          size="sq-sm"
          selectionMode="multiple"
          selectedKeys={draft.weekdays}
          onSelectionChange={(keys) => set("weekdays")([...keys].map(Number))}
        >
          {WEEKDAYS.map((day) => (
            <ToggleGroupItem key={day.id} id={day.id} aria-label={day.name}>
              {day.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </SettingsFormDialog>
  );
}

/** What a failed create says: the field the Worker named, or that it was not made. */
export const bookingFailed = (error: unknown) =>
  appToast.error(
    error instanceof ApiError && error.param
      ? `Check the ${error.param}`
      : "The link was not created",
  );
