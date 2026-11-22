import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty/empty-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api.ts";
import { useBook, useBookingPage } from "@/hooks/use-booking.ts";

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const longDay = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function useDays(slots: readonly string[]) {
  return useMemo(() => {
    const days = new Map<string, Date[]>();
    for (const slot of slots) {
      const date = new Date(slot);
      const key = localDay(date);
      days.set(key, [...(days.get(key) ?? []), date]);
    }
    return [...days.entries()].map(([key, times]) => ({ key, times }));
  }, [slots]);
}

function Booked(props: { start: Date; title: string }) {
  return (
    <div className="flex flex-col gap-1 p-6 text-center">
      <span className="text-base text-foreground">Booked</span>
      <span className="text-muted-foreground">
        {props.title} · {longDay.format(props.start)}, {timeFormat.format(props.start)}
      </span>
    </div>
  );
}

function BookForm(props: { slug: string; start: Date; onBack: () => void; onBooked: () => void }) {
  const book = useBook(props.slug);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const submit = () =>
    book.mutate(
      {
        start: props.start.toISOString(),
        name: name.trim(),
        email: email.trim(),
        note: note.trim() || null,
        timeZone: zone(),
      },
      {
        onSuccess: props.onBooked,
        onError: (error) => {
          if (error instanceof ApiError && error.code === "slot_taken") {
            appToast.error("That time was just taken");
            props.onBack();
          } else appToast.error("The meeting was not booked");
        },
      },
    );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span className="text-foreground">
        {longDay.format(props.start)}, {timeFormat.format(props.start)}
      </span>
      <TextField isRequired autoFocus maxLength={200} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input autoComplete="name" />
      </TextField>
      <TextField isRequired type="email" maxLength={320} value={email} onChange={setEmail}>
        <Label>Email</Label>
        <Input autoComplete="email" />
      </TextField>
      <TextField maxLength={2000} value={note} onChange={setNote}>
        <Label>Note</Label>
        <Textarea rows={3} />
      </TextField>
      <div className="flex justify-end gap-2">
        <Button intent="outline" onPress={props.onBack} isDisabled={book.isPending}>
          Back
        </Button>
        <Button
          type="submit"
          intent="primary"
          isPending={book.isPending}
          isDisabled={!name.trim() || !email.trim()}
        >
          Book
        </Button>
      </div>
    </form>
  );
}

/** A booking link's public page: the owner's free slots, in the visitor's own time zone. */
export function BookingPage(props: { slug: string }) {
  const { data: page } = useBookingPage(props.slug);
  const days = useDays(page.slots);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<Date | null>(null);
  const [booked, setBooked] = useState<Date | null>(null);
  const day = days.find((d) => d.key === dayKey) ?? days[0];
  return (
    <div className="flex min-h-svh items-start justify-center bg-background px-4 py-16">
      <Card className="flex w-full max-w-xl flex-col gap-5 p-6">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">{page.ownerName}</span>
          <h1 className="text-lg text-foreground">{page.title}</h1>
          <span className="text-muted-foreground tabular-nums">
            {page.durationMinutes} min · {zone()}
          </span>
        </div>
        {booked ? (
          <Booked start={booked} title={page.title} />
        ) : picked ? (
          <BookForm
            slug={props.slug}
            start={picked}
            onBack={() => setPicked(null)}
            onBooked={() => setBooked(picked)}
          />
        ) : !day ? (
          <EmptyState figure="loupe" title="No times free" />
        ) : (
          <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-4">
            <div
              className="flex max-h-96 flex-col gap-1 overflow-y-auto"
              role="group"
              aria-label="Days"
            >
              {days.map((d) => (
                <Button
                  key={d.key}
                  size="sm"
                  intent={d.key === day.key ? "secondary" : "plain"}
                  aria-pressed={d.key === day.key}
                  className="justify-start tabular-nums"
                  onPress={() => setDayKey(d.key)}
                >
                  {dayFormat.format(d.times[0]!)}
                </Button>
              ))}
            </div>
            <div
              role="group"
              aria-label="Times"
              className="grid content-start grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {day.times.map((time) => (
                <Button
                  key={time.toISOString()}
                  size="sm"
                  intent="outline"
                  className="tabular-nums"
                  onPress={() => setPicked(time)}
                >
                  {timeFormat.format(time)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
