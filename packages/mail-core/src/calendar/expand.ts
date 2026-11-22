import ICAL from "ical.js";
import { dayOf, instantOf, nextDay, wallClockAt } from "./zones.ts";

/** The most instances one series yields for one window. */
export const SERIES_INSTANCES_MAX = 1000;
const STEPS_MAX = 50_000;

/** What expanding needs of a series: its first instance and its rule. */
export interface Series {
  start: Date;
  end: Date;
  allDay: boolean;
  startDay: string | null;
  endDay: string | null;
  timeZone: string | null;
  rrule: string | null;
  exdates: readonly Date[];
  rdates: readonly Date[];
}

export interface Instance {
  /** The instance's original start: what a changed instance's `RECURRENCE-ID` names. */
  recurrenceId: Date;
  start: Date;
  end: Date;
  startDay: string | null;
  endDay: string | null;
}

const DAY_MS = 86_400_000;

function firstTime(series: Series, zone: string) {
  if (series.allDay && series.startDay) {
    return ICAL.Time.fromDateString(series.startDay);
  }
  const clock = wallClockAt(series.start, zone);
  return ICAL.Time.fromData({ ...clock, isDate: false });
}

function ruleOf(series: Series, zone: string) {
  if (!series.rrule) return null;
  let recur: ICAL.Recur;
  try {
    recur = ICAL.Recur.fromString(series.rrule);
  } catch {
    return null;
  }
  const until = recur.until;
  if (until && !until.isDate && until.toString().endsWith("Z")) {
    // WARNING: UNTIL is a UTC instant and the iterator walks wall-clock time; unconverted, the last instance is lost east of Greenwich.
    const instant = new Date(until.toUnixTime() * 1000);
    recur.until = ICAL.Time.fromData({ ...wallClockAt(instant, zone), isDate: false });
  }
  return recur;
}

/**
 * Every instance of `series` that overlaps `[from, to)`, oldest first, at most `limit`.
 * The rule is walked in the event's own zone, so a weekly 10:00 in Madrid stays at 10:00 when the
 * clocks change; `EXDATE`s are removed and `RDATE`s added. A series without a rule is its one
 * instance.
 */
export function expandSeries(
  series: Series,
  window: { from: Date; to: Date },
  limit = SERIES_INSTANCES_MAX,
) {
  const zone = series.timeZone ?? "UTC";
  const length = series.end.getTime() - series.start.getTime();
  const spanDays =
    series.allDay && series.startDay && series.endDay
      ? Math.max(1, Math.round((Date.parse(series.endDay) - Date.parse(series.startDay)) / DAY_MS))
      : 0;
  const excluded = new Set(series.exdates.map((date) => date.getTime()));
  const instances = new Map<number, Instance>();
  const add = (start: Date) => {
    if (excluded.has(start.getTime())) return;
    const startDay = series.allDay ? start.toISOString().slice(0, 10) : null;
    const endDay = startDay ? nextDay(startDay, spanDays) : null;
    const end = endDay ? new Date(`${endDay}T00:00:00Z`) : new Date(start.getTime() + length);
    if (end <= window.from || start >= window.to) return;
    instances.set(start.getTime(), { recurrenceId: start, start, end, startDay, endDay });
  };

  const rule = ruleOf(series, zone);
  if (!rule) add(series.start);
  else {
    const before = window.from.getTime() - Math.max(length, spanDays * DAY_MS) - DAY_MS;
    const iterator = rule.iterator(startNear(firstTime(series, zone), rule, before));
    for (let step = 0; step < STEPS_MAX && instances.size < limit; step++) {
      const next = iterator.next();
      if (!next) break;
      if (wallClockMs(next) < before) continue;
      const start = instantAt(next, series.allDay, zone);
      if (start >= window.to) break;
      add(start);
    }
  }
  for (const date of series.rdates) add(date);
  return [...instances.values()]
    .toSorted((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit);
}

const PERIOD_DAYS: Partial<Record<string, number>> = { DAILY: 1, WEEKLY: 7 };

function startNear(first: ICAL.Time, rule: ICAL.Recur, before: number) {
  const days = PERIOD_DAYS[rule.freq];
  // WARNING: COUNT counts from the real first start; moving it would let the series run past its last instance.
  if (!days || rule.count) return first;
  const period = days * Math.max(1, rule.interval || 1);
  const ahead = Math.floor((before - 7 * DAY_MS - wallClockMs(first)) / DAY_MS / period);
  if (ahead <= 0) return first;
  const moved = first.clone();
  moved.adjust(ahead * period, 0, 0, 0);
  return moved;
}

const wallClockMs = (time: ICAL.Time) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);

function instantAt(time: ICAL.Time, allDay: boolean, zone: string) {
  const clock = { year: time.year, month: time.month, day: time.day };
  if (allDay) return new Date(`${dayOf(clock)}T00:00:00Z`);
  return instantOf({ ...clock, hour: time.hour, minute: time.minute, second: time.second }, zone);
}

/**
 * When a series is over: the end of its last instance, or null when it never ends. A series
 * without a rule ends with its one instance. Stored as `recurs_until`, so a read finds the series
 * that reach its window without expanding the rest.
 */
export function seriesEnd(series: Series) {
  const zone = series.timeZone ?? "UTC";
  const rule = ruleOf(series, zone);
  const lastRdate = series.rdates.reduce<number>((max, d) => Math.max(max, d.getTime()), 0);
  const length = series.end.getTime() - series.start.getTime();
  if (!rule) return new Date(Math.max(series.end.getTime(), lastRdate + length));
  if (!rule.until && !rule.count) return null;
  const iterator = rule.iterator(firstTime(series, zone));
  let last = series.start;
  for (let step = 0; step < STEPS_MAX; step++) {
    const next = iterator.next();
    if (!next) break;
    last = instantAt(next, series.allDay, zone);
  }
  return new Date(
    Math.max(last.getTime(), lastRdate) + Math.max(length, series.allDay ? DAY_MS : 0),
  );
}
