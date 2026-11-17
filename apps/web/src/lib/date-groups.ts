const MONTH = new Intl.DateTimeFormat(undefined, { month: "long" });
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
function midnight(date: Date, days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The group a date falls in, seen from `now`. Weeks start on Monday. */
export function dateGroup(iso: string, now = new Date()) {
  const date = new Date(iso);
  const sinceMonday = (now.getDay() + 6) % 7;
  if (date >= midnight(now)) return "Today";
  if (date >= midnight(now, -1)) return "Yesterday";
  if (date >= midnight(now, -sinceMonday)) return "This week";
  if (date >= midnight(now, -sinceMonday - 7)) return "Last week";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "This month";
  }
  return (date.getFullYear() === now.getFullYear() ? MONTH : MONTH_YEAR).format(date);
}

export interface DateGroup<T> {
  /** Unique within the list: a label can repeat if the rows are not in date order. */
  id: string;
  label: string;
  rows: T[];
}

/** Consecutive rows that share a group, in their own order. */
export function groupByDate<T>(rows: T[], date: (row: T) => string, now = new Date()) {
  const groups: DateGroup<T>[] = [];
  for (const row of rows) {
    const label = dateGroup(date(row), now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ id: `${label}:${groups.length}`, label, rows: [row] });
  }
  return groups;
}
