import { findIana } from "windows-iana";

/** A wall-clock time with no zone: what a calendar shows. */
export interface WallClock {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string) {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

/** Whether the runtime knows `zone` as an IANA time zone. */
export function isIanaZone(zone: string) {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA zone a `TZID` names: an IANA name as it is, a Windows name (`Romance Standard Time`,
 * which Outlook sends) through CLDR's table, and a quoted or `/`-prefixed name unwrapped. Null when
 * neither knows it; the caller then falls back to the file's own `VTIMEZONE`.
 */
export function resolveZone(tzid: string | null | undefined) {
  if (!tzid) return null;
  const name = tzid.trim().replace(/^"|"$/g, "").replace(/^\/+/, "").trim();
  if (!name) return null;
  if (name.toUpperCase() === "UTC" || name.toUpperCase() === "GMT" || name === "Z") return "UTC";
  if (isIanaZone(name) && name.includes("/")) return name;
  const windows = findIana(name)[0];
  if (windows && isIanaZone(windows)) return windows;
  return isIanaZone(name) ? name : null;
}

/** `instant` as a wall clock in `zone`. */
export function wallClockAt(instant: Date, zone: string) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const clock: WallClock = {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
  return clock;
}

const asUtc = (clock: WallClock) =>
  Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);

function offsetAt(zone: string, instantMs: number) {
  return asUtc(wallClockAt(new Date(instantMs), zone)) - instantMs;
}

/**
 * The instant a wall clock in `zone` names. In the hour a clock skips (spring forward) it lands
 * an hour later, and in the hour it repeats (fall back) on the first of the two, as calendar apps
 * do.
 */
export function instantOf(clock: WallClock, zone: string) {
  const guess = asUtc(clock);
  if (zone === "UTC") return new Date(guess);
  const HALF_DAY = 12 * 3_600_000;
  const candidates = [
    ...new Set([
      guess - offsetAt(zone, guess - HALF_DAY),
      guess - offsetAt(zone, guess + HALF_DAY),
    ]),
  ];
  const exact = candidates.filter((t) => asUtc(wallClockAt(new Date(t), zone)) === guess);
  return new Date(exact.length > 0 ? Math.min(...exact) : Math.max(...candidates));
}

/** `YYYY-MM-DD` of a wall clock. */
export const dayOf = (clock: Pick<WallClock, "year" | "month" | "day">) =>
  `${String(clock.year).padStart(4, "0")}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;

/** The day after `day` (`YYYY-MM-DD`). */
export function nextDay(day: string, days = 1) {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}
