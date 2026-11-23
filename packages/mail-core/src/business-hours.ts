import { dayOf, instantOf, nextDay, wallClockAt } from "./calendar/zones.ts";

export interface BusinessHoursWindow {
  /** 0 is Sunday. */
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** `HH:MM` in the schedule's zone. */
  start: string;
  /** `HH:MM` in the schedule's zone, after `start`; `24:00` is midnight at the end of the day. */
  end: string;
}

export interface BusinessSchedule {
  /** IANA zone, e.g. `America/Mexico_City`. */
  timezone: string;
  windows: BusinessHoursWindow[];
  /** Closed all day, as `YYYY-MM-DD` in the zone. */
  holidays: string[];
}

const MINUTE = 60_000;
const MAX_CLOSED_DAYS = 400;

/**
 * The moment `minutes` of staffed time after `start` have passed. With no schedule, or one with no
 * windows, every minute counts. Null when the schedule stays closed for over a year at a stretch.
 */
export const addBusinessMinutes: (
  start: Date,
  minutes: number,
  schedule: BusinessSchedule | null,
) => Date | null = (start, minutes, schedule) => {
  if (!schedule || schedule.windows.length === 0)
    return new Date(start.getTime() + minutes * MINUTE);
  const holidays = new Set(schedule.holidays);
  const byDay = new Map<number, { start: number; end: number }[]>();
  for (const w of schedule.windows) {
    const list = byDay.get(w.day) ?? [];
    list.push({ start: minutesOf(w.start), end: minutesOf(w.end) });
    byDay.set(w.day, list);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.start - b.start);

  let cursor = start.getTime();
  let remaining = minutes * MINUTE;
  let day = dayOf(wallClockAt(start, schedule.timezone));
  for (let closed = 0; closed < MAX_CLOSED_DAYS; closed++, day = nextDay(day)) {
    if (holidays.has(day)) continue;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    for (const window of byDay.get(weekday) ?? []) {
      const opens = Math.max(cursor, epochMsAtMinuteOfDay(day, window.start, schedule.timezone));
      const closes = epochMsAtMinuteOfDay(day, window.end, schedule.timezone);
      if (opens >= closes) continue;
      if (remaining <= closes - opens) return new Date(opens + remaining);
      remaining -= closes - opens;
      cursor = closes;
      closed = -1;
    }
  }
  return null;
};

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function epochMsAtMinuteOfDay(day: string, minutes: number, zone: string) {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  const clock = {
    year,
    month,
    day: date,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
  };
  return instantOf(clock, zone).getTime();
}
