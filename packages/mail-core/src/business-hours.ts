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
  let day = localDate(start, schedule.timezone);
  for (let closed = 0; closed < MAX_CLOSED_DAYS; closed++, day = nextDay(day)) {
    const iso = isoDate(day);
    if (holidays.has(iso)) continue;
    const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    for (const window of byDay.get(weekday) ?? []) {
      const opens = Math.max(cursor, zonedTime(day, window.start, schedule.timezone));
      const closes = zonedTime(day, window.end, schedule.timezone);
      if (opens >= closes) continue;
      if (remaining <= closes - opens) return new Date(opens + remaining);
      remaining -= closes - opens;
      cursor = closes;
      closed = -1;
    }
  }
  return null;
};

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface LocalDate {
  y: number;
  m: number;
  d: number;
}

function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function isoDate({ y, m, d }: LocalDate) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function nextDay({ y, m, d }: LocalDate) {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    y: next.getUTCFullYear(),
    m: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
  } satisfies LocalDate;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: number, zone: string) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(at))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

function localDate(at: Date, zone: string) {
  const p = wallClock(at.getTime(), zone);
  return { y: p.year, m: p.month, d: p.day } satisfies LocalDate;
}

function offsetAt(at: number, zone: string) {
  const p = wallClock(at, zone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
  );
}

function zonedTime(day: LocalDate, minutes: number, zone: string) {
  const wall = Date.UTC(day.y, day.m - 1, day.d) + minutes * MINUTE;
  const candidates = [
    ...new Set([12, -12].map((h) => wall - offsetAt(wall + h * 3_600_000, zone))),
  ];
  const real = candidates.filter((at) => at + offsetAt(at, zone) === wall);
  return real.length ? Math.min(...real) : Math.max(...candidates);
}
