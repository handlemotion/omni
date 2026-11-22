import { calendarText, CALENDAR_TEXT_MAX } from "./parse.ts";

/** One calendar of a Google account, from its calendar list. */
export interface GoogleCalendarEntry {
  /** Google's id for it, what `events.list` takes. */
  googleId: string;
  /** The account's own name for it, else the calendar's. */
  name: string | null;
  /** Google's colour for it, `#rrggbb` in lower case; null when Google gave none Omni can show. */
  color: string | null;
  /** The account's own calendar: Omni shows it on the inbox's own calendar. */
  primary: boolean;
}

const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Reads one `calendarList.list` item (API v3) into a calendar the inbox shows
 * (`docs/spec/calendar.md`, "Google calendars"). Null for an entry Google marks deleted or that
 * has no id: the list is untrusted input like mail.
 */
export function readGoogleCalendar(item: unknown) {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const entry = item as Record<string, unknown>;
  if (entry.deleted === true) return null;
  const googleId = typeof entry.id === "string" ? calendarText(entry.id, 1024) : null;
  if (!googleId) return null;
  const color = typeof entry.backgroundColor === "string" ? entry.backgroundColor : "";
  const calendar: GoogleCalendarEntry = {
    googleId,
    name:
      calendarText(entry.summaryOverride, CALENDAR_TEXT_MAX) ??
      calendarText(entry.summary, CALENDAR_TEXT_MAX),
    color: COLOR.test(color) ? color.toLowerCase() : null,
    primary: entry.primary === true,
  };
  return calendar;
}

/** The calendars a calendar list holds, each once, the primary one included. */
export function readGoogleCalendars(items: readonly unknown[]) {
  const seen = new Map<string, GoogleCalendarEntry>();
  for (const item of items) {
    const calendar = readGoogleCalendar(item);
    if (calendar && !seen.has(calendar.googleId)) seen.set(calendar.googleId, calendar);
  }
  return [...seen.values()];
}
