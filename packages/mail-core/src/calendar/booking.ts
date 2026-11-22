import { dayOf, instantOf, nextDay, wallClockAt } from "./zones.ts";

/** When a booking link takes meetings, in its own time zone. */
export interface BookingRules {
  /** IANA zone the hours and days are in. */
  timeZone: string;
  /** Days of the week it takes meetings; 0 is Sunday. */
  weekdays: readonly number[];
  /** Minutes after midnight the day opens, and closes (`1440` is midnight at its end). */
  startMinute: number;
  endMinute: number;
  /** The meeting's length. Slots start every `durationMinutes`, from the day's opening. */
  durationMinutes: number;
  /** How soon from now the first slot may start. */
  noticeMinutes: number;
  /** How many days ahead, counted from today in the link's zone, it offers. */
  horizonDays: number;
}

/** A busy stretch, `[start, end)`. */
export interface BusyBlock {
  start: Date;
  end: Date;
}

const MINUTE = 60_000;

/** The window `rules` can offer slots in from `now`: today in the link's zone to the horizon. */
export function bookingWindow(rules: BookingRules, now: Date) {
  const today = dayOf(wallClockAt(now, rules.timeZone));
  const last = nextDay(today, rules.horizonDays);
  return {
    from: midnight(today, rules.timeZone),
    to: midnight(last, rules.timeZone),
    days: Array.from({ length: rules.horizonDays }, (_, i) => nextDay(today, i)),
  };
}

function midnight(day: string, zone: string) {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return instantOf({ year, month, day: date, hour: 0, minute: 0, second: 0 }, zone);
}

function at(day: string, minute: number, zone: string) {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  if (minute >= 1440) return midnight(nextDay(day), zone);
  return instantOf(
    { year, month, day: date, hour: Math.floor(minute / 60), minute: minute % 60, second: 0 },
    zone,
  );
}

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * The starts a visitor may book, soonest first: inside the link's hours on its days, at least
 * `noticeMinutes` from now, and overlapping no busy block. Each slot is `durationMinutes` long and
 * they follow one another from the day's opening, so a day of 9:00–12:00 with 50 minutes offers
 * 9:00, 9:50 and 10:40. Wall clocks are the link's zone, so a slot keeps its hour across a change
 * of clocks; a slot lasts exactly `durationMinutes`, as the booked event will, and never runs
 * past closing. A start the clocks skip (spring forward) is not offered.
 */
export function bookingSlots(rules: BookingRules, busy: readonly BusyBlock[], now: Date) {
  const length = rules.durationMinutes;
  if (length <= 0 || rules.endMinute <= rules.startMinute) return [];
  const earliest = now.getTime() + rules.noticeMinutes * MINUTE;
  const blocks = busy
    .map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const weekdays = new Set(rules.weekdays);
  const slots: Date[] = [];
  for (const day of bookingWindow(rules, now).days) {
    if (!weekdays.has(weekdayOf(day))) continue;
    const closing = at(day, rules.endMinute, rules.timeZone).getTime();
    for (let m = rules.startMinute; m + length <= rules.endMinute; m += length) {
      const instant = at(day, m, rules.timeZone);
      const clock = wallClockAt(instant, rules.timeZone);
      if (clock.hour * 60 + clock.minute !== m) continue;
      const start = instant.getTime();
      const end = start + length * MINUTE;
      if (start < earliest || end > closing) continue;
      if (blocks.some((b) => b.start < end && b.end > start)) continue;
      slots.push(new Date(start));
    }
  }
  return slots;
}

/** Whether `start` is one of the slots `rules` offers now. */
export const isBookable = (
  rules: BookingRules,
  busy: readonly BusyBlock[],
  now: Date,
  start: Date,
) => bookingSlots(rules, busy, now).some((slot) => slot.getTime() === start.getTime());
