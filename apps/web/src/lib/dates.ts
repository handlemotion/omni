/** "Nov 12" */
export const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "Nov 12, 2026" */
export const DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "3:04 PM" */
export const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A list row's date: the time today, the day before. */
export function rowTime(iso: string) {
  const date = new Date(iso);
  return (new Date().toDateString() === date.toDateString() ? TIME : DAY).format(date);
}
