import { SHEET_LIMITS } from "../format.ts";
import type { SheetFunction } from "./functions.ts";
import {
  dateOf,
  errors,
  isError,
  numberText,
  Range,
  serialOf,
  toNumber,
  toText,
  type Arg,
  type Value,
} from "./values.ts";

const text = (fn: (s: string, ...rest: number[]) => Value, arity = 1) =>
  ((args) => {
    if (args.length < arity) return errors.value;
    const s = toText(args[0]!);
    if (isError(s)) return s;
    const rest: number[] = [];
    for (const arg of args.slice(1)) {
      const n = toNumber(arg);
      if (isError(n)) return n;
      rest.push(n);
    }
    return fn(s, ...rest);
  }) satisfies SheetFunction;

function joined(args: Arg[]) {
  let out = "";
  for (const arg of args) {
    for (const v of arg instanceof Range ? arg.flat : [arg]) {
      const t = toText(v);
      if (isError(t)) return t;
      if (out.length + t.length > SHEET_LIMITS.cellChars) return errors.value;
      out += t;
    }
  }
  return out;
}

function substitute(s: string, from: string, to: string, nth: number | undefined) {
  if (from === "") return s;
  const parts = s.split(from);
  if (nth !== undefined) {
    if (nth < 1) return errors.value;
    if (nth >= parts.length) return s;
    return parts.slice(0, nth).join(from) + to + parts.slice(nth).join(from);
  }
  const length = s.length + (parts.length - 1) * (to.length - from.length);
  return length > SHEET_LIMITS.cellChars ? errors.value : parts.join(to);
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function dateText(serial: number, format: string) {
  const d = dateOf(serial);
  return format
    .replace(/yyyy/i, String(d.getUTCFullYear()))
    .replace(/yy/i, pad(d.getUTCFullYear() % 100, 2))
    .replace(/mm/i, pad(d.getUTCMonth() + 1, 2))
    .replace(/dd/i, pad(d.getUTCDate(), 2));
}

/** `TEXT` for the common formats: `0`, `0.00`, `#,##0.00`, `0%`, and dates (`yyyy-mm-dd`). */
export function formatNumber(n: number, format: string) {
  if (/[ymd]/i.test(format)) return dateText(n, format);
  const percent = format.endsWith("%");
  const body = percent ? format.slice(0, -1) : format;
  const decimals = Math.min((body.split(".")[1] ?? "").replaceAll(/[^0#]/g, "").length, 30);
  const value = percent ? n * 100 : n;
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole = "0", fraction] = fixed.split(".");
  const grouped = body.includes(",") ? whole.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}${percent ? "%" : ""}`;
}

const date = (fn: (d: Date) => number) =>
  ((args) => {
    const n = toNumber(args[0] ?? null);
    return isError(n) ? n : fn(dateOf(n));
  }) satisfies SheetFunction;

const addMonths = (serial: number, months: number) => {
  const d = dateOf(serial);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
  const end = new Date(
    Date.UTC(new Date(target).getUTCFullYear(), new Date(target).getUTCMonth() + 1, 0),
  );
  return serialOf(target) + Math.min(d.getUTCDate(), end.getUTCDate()) - 1;
};

function datedif(start: number, end: number, unit: string) {
  if (end < start) return errors.num;
  const a = dateOf(start);
  const b = dateOf(end);
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    b.getUTCMonth() -
    a.getUTCMonth() -
    (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
  switch (unit.toUpperCase()) {
    case "D":
      return Math.floor(end) - Math.floor(start);
    case "M":
      return months;
    case "Y":
      return Math.floor(months / 12);
    default:
      return errors.num;
  }
}

const LAST_SERIAL = 2_958_465;

const weekdaysThrough = (serial: number) => {
  const weeks = Math.floor(serial / 7);
  const rest = serial - weeks * 7;
  const partial = [0, 0, 1, 2, 3, 4, 5][rest]!;
  return weeks * 5 + partial;
};

function holidaysIn(arg: Arg | undefined) {
  const days = new Set<number>();
  if (arg === undefined) return days;
  for (const v of arg instanceof Range ? arg.flat : [arg]) {
    if (v === null) continue;
    const n = toNumber(v);
    if (isError(n)) return n;
    days.add(Math.floor(n));
  }
  return days;
}

function networkdays(start: number, end: number, holidays: Set<number>) {
  if (![start, end].every((n) => n >= 0 && n <= LAST_SERIAL)) return errors.num;
  const [from, to, sign] = start <= end ? [start, end, 1] : [end, start, -1];
  const first = Math.floor(from);
  const last = Math.floor(to);
  let off = 0;
  for (const day of holidays) {
    if (day >= first && day <= last && day % 7 >= 2) off++;
  }
  return (weekdaysThrough(last) - weekdaysThrough(first - 1) - off) * sign;
}

export const textFunctions: Record<string, SheetFunction> = {
  CONCAT: (args) => joined(args),
  CONCATENATE: (args) => joined(args),
  LEFT: text((s, n = 1) => (n < 0 ? errors.value : s.slice(0, n))),
  RIGHT: text((s, n = 1) => (n < 0 ? errors.value : n === 0 ? "" : s.slice(-n))),
  MID: text(
    (s, start, n) => (start < 1 || n! < 0 ? errors.value : s.slice(start - 1, start - 1 + n!)),
    3,
  ),
  LEN: text((s) => s.length),
  TRIM: text((s) => s.trim().replaceAll(/ {2,}/g, " ")),
  UPPER: text((s) => s.toUpperCase()),
  LOWER: text((s) => s.toLowerCase()),
  PROPER: text((s) =>
    s
      .toLowerCase()
      .replaceAll(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()),
  ),
  REPT: text(
    (s, n) =>
      n! < 0 || s.length * Math.floor(n!) > SHEET_LIMITS.cellChars
        ? errors.value
        : s.repeat(Math.floor(n!)),
    2,
  ),
  SUBSTITUTE: (args) => {
    const [s, from, to] = args.slice(0, 3).map((a) => toText(a));
    const nth = args[3] === undefined ? undefined : toNumber(args[3]);
    if (isError(s) || isError(from) || isError(to) || s === undefined || from === undefined)
      return errors.value;
    if (isError(nth)) return nth;
    const out = substitute(s, from, to ?? "", nth === undefined ? undefined : Math.floor(nth));
    return typeof out === "string" && out.length > SHEET_LIMITS.cellChars ? errors.value : out;
  },
  FIND: (args) => {
    const needle = toText(args[0] ?? null);
    const hay = toText(args[1] ?? null);
    if (isError(needle) || isError(hay)) return errors.value;
    const at = hay.indexOf(needle);
    return at < 0 ? errors.value : at + 1;
  },
  TEXT: (args) => {
    const n = toNumber(args[0] ?? null);
    const format = toText(args[1] ?? null);
    if (isError(format)) return format;
    return isError(n) ? toText(args[0] ?? null) : formatNumber(n, format);
  },
  VALUE: (args) => toNumber(args[0] ?? null),
  DATE: (args) => {
    const [y, m, d] = args.slice(0, 3).map((a) => toNumber(a));
    if (
      isError(y) ||
      isError(m) ||
      isError(d) ||
      y === undefined ||
      m === undefined ||
      d === undefined
    )
      return errors.value;
    return serialOf(Date.UTC(y, m - 1, d));
  },
  TODAY: (_args, ctx) => Math.floor(ctx.now),
  NOW: (_args, ctx) => ctx.now,
  YEAR: date((d) => d.getUTCFullYear()),
  MONTH: date((d) => d.getUTCMonth() + 1),
  DAY: date((d) => d.getUTCDate()),
  WEEKDAY: date((d) => d.getUTCDay() + 1),
  EDATE: (args) => {
    const s = toNumber(args[0] ?? null);
    const m = toNumber(args[1] ?? null);
    return isError(s) ? s : isError(m) ? m : addMonths(Math.floor(s), Math.trunc(m));
  },
  EOMONTH: (args) => {
    const s = toNumber(args[0] ?? null);
    const m = toNumber(args[1] ?? null);
    if (isError(s) || isError(m)) return errors.value;
    const d = dateOf(Math.floor(s));
    return serialOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(m) + 1, 0));
  },
  DATEDIF: (args) => {
    const a = toNumber(args[0] ?? null);
    const b = toNumber(args[1] ?? null);
    const unit = toText(args[2] ?? null);
    if (isError(a) || isError(b) || isError(unit)) return errors.value;
    return datedif(a, b, unit);
  },
  NETWORKDAYS: (args) => {
    const a = toNumber(args[0] ?? null);
    const b = toNumber(args[1] ?? null);
    if (isError(a) || isError(b)) return errors.value;
    const holidays = holidaysIn(args[2]);
    return isError(holidays) ? holidays : networkdays(a, b, holidays);
  },
};

export { numberText };
