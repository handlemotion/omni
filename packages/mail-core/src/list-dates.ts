const DAY_MS = 86_400_000;

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * Whole calendar days from `date` to `now` in the device's zone: 0 today, 1 yesterday, negative
 * in the future. A 23- or 25-hour day around a clock change still counts as one.
 */
export const daysAgo = (date: Date, now: Date) =>
  Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let found = formats.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formats.set(key, found);
  }
  return found;
};

/** A row's time: the clock today, the weekday within the week, the date before (its year when not this one). */
export function listTime(iso: string, now = new Date(), locale?: string) {
  const date = new Date(iso);
  const ago = daysAgo(date, now);
  if (ago <= 0) return format(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  if (ago < 7) return format(locale, { weekday: "short" }).format(date);
  return format(
    locale,
    date.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  ).format(date);
}

/** The heading a day's rows sit under: Today, Yesterday, a weekday within the week, then a month. */
export function dayHeading(iso: string, now = new Date(), locale?: string) {
  const date = new Date(iso);
  const ago = daysAgo(date, now);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return format(locale, { weekday: "long" }).format(date);
  return format(
    locale,
    date.getFullYear() === now.getFullYear()
      ? { month: "long" }
      : { month: "long", year: "numeric" },
  ).format(date);
}

export type Sectioned<T> =
  | { kind: "heading"; id: string; label: string }
  | { kind: "row"; id: string; item: T };

/**
 * `items` (newest first) with a heading before each new `dayHeading`. A heading never repeats,
 * even if an out-of-order item comes back to an earlier day: it joins the section it's in.
 */
export function bySection<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  isoOf: (item: T) => string,
  now = new Date(),
  locale?: string,
) {
  const out: Sectioned<T>[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const label = dayHeading(isoOf(item), now, locale);
    if (!seen.has(label)) {
      seen.add(label);
      out.push({ kind: "heading", id: `heading:${label}`, label });
    }
    out.push({ kind: "row", id: idOf(item), item });
  }
  return out;
}
