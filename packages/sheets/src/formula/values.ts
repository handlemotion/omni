/** A formula error, by its Excel code. */
export class SheetError {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}

/** A computed value: empty is null. */
export type Value = number | string | boolean | null | SheetError;

/** A range's values, by row then column. */
export class Range {
  readonly rows: Value[][];
  constructor(rows: Value[][]) {
    this.rows = rows;
  }
  get flat() {
    return this.rows.flat();
  }
}

export type Arg = Value | Range;

export const errors = {
  div0: new SheetError("#DIV/0!"),
  value: new SheetError("#VALUE!"),
  ref: new SheetError("#REF!"),
  name: new SheetError("#NAME?"),
  num: new SheetError("#NUM!"),
  na: new SheetError("#N/A"),
};

export const isError = (value: unknown): value is SheetError => value instanceof SheetError;

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?%?$/;

/** `text` as a number, when it reads as one; else null. */
export function parseNumber(text: string) {
  const t = text.trim().replaceAll(",", "");
  if (!NUMBER.test(t)) return null;
  return t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t);
}

/** One value out of an argument: a range gives its top-left, or `#VALUE!` when larger. */
export function single(arg: Arg) {
  if (!(arg instanceof Range)) return arg;
  if (arg.rows.length === 1 && arg.rows[0]!.length === 1) return arg.rows[0]![0]!;
  return errors.value;
}

export function toNumber(arg: Arg) {
  const value = single(arg);
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (isError(value)) return value;
  return parseNumber(value) ?? errors.value;
}

/** A number as a cell shows it with no format: up to 15 significant digits. */
export const numberText = (n: number) => String(Number(n.toPrecision(15)));

export function toText(arg: Arg) {
  const value = single(arg);
  if (value === null) return "";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return value;
}

export function toBool(arg: Arg) {
  const value = single(arg);
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (isError(value)) return value;
  const upper = value.toUpperCase();
  return upper === "TRUE" ? true : upper === "FALSE" ? false : errors.value;
}

const DAY = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Excel's serial day number of a UTC date (the 1900 system, from March 1900 on). */
export const serialOf = (ms: number) => (ms - EPOCH) / DAY;

/** The UTC date of a serial day number. */
export const dateOf = (serial: number) => new Date(EPOCH + Math.round(serial * DAY));

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** An ISO date (`2026-11-22`, or with a time) as a serial number; null when it is not one. */
export function isoSerial(text: string) {
  const m = ISO.exec(text.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(ms) ? null : serialOf(ms);
}

/** A serial number as an ISO date, with its time when it has one. */
export function serialIso(serial: number) {
  const iso = dateOf(serial).toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16);
}

/** Compares two values the way Excel does: numbers < text < booleans; text without case. */
export function compare(a: Value, b: Value) {
  const rank = (v: Value) =>
    typeof v === "number" || v === null ? 0 : typeof v === "string" ? 1 : 2;
  const x = a === null && typeof b === "string" ? "" : a;
  const y = b === null && typeof a === "string" ? "" : b;
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === "string" && typeof y === "string") {
    const u = x.toLowerCase();
    const v = y.toLowerCase();
    return u < v ? -1 : u > v ? 1 : 0;
  }
  const n = Number(x ?? 0);
  const m = Number(y ?? 0);
  return n < m ? -1 : n > m ? 1 : 0;
}
