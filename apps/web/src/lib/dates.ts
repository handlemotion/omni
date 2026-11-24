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

/** How long ago, in the largest whole unit: "now", "5m ago", "3h ago", "226d ago". */
export function ago(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
