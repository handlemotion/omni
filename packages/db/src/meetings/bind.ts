import { memberCalendar, type CalendarEventView, type OccurrenceRef } from "../calendar.ts";
import type { Db } from "../client.ts";
import { groupKeyFor, NOT_FOUND } from "./core.ts";
import type { StartMeeting } from "./write.ts";

/**
 * Which calendar meeting a recording is of: one the person picked (its row as the calendar shows
 * it, or its `UID`, with the instance's original start in a series), `"now"` for the one they are
 * in, or `null` for none.
 */
export type MeetingEventChoice = (OccurrenceRef & { recurrenceId?: string | null }) | "now" | null;

export interface StartRecording {
  title: string | null;
  event: MeetingEventChoice;
  /** People the recorder adds; an event's attendees come from the calendar, not from here. */
  attendees: Array<{ address: string; name: string | null }>;
  /** The workspace's own domains, which never name a client group. */
  ownDomains?: string[];
  /** A group chosen by a trusted caller; otherwise worked out from the event and attendees. */
  groupKey?: string | null;
  consent: boolean;
}

/** The instance key a meeting keeps: the original start as ISO, `''` for a single event. */
export const recurrenceKey = (recurrenceId: Date | null) => recurrenceId?.toISOString() ?? "";

function recurrenceOf(value: string | null | undefined) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

async function eventOf(db: Db, memberId: string, choice: MeetingEventChoice, now: Date) {
  if (choice === null) return { status: "ok" as const, event: null };
  const calendar = memberCalendar(db, memberId);
  if (choice === "now") return { status: "ok" as const, event: await calendar.occurrenceAt(now) };
  const recurrenceId = recurrenceOf(choice.recurrenceId);
  if (recurrenceId === undefined) return NOT_FOUND;
  const ref = "id" in choice ? { id: choice.id } : { uid: choice.uid };
  const found = await calendar.occurrence(ref, recurrenceId);
  return found.status === "ok" ? found : NOT_FOUND;
}

const lower = (address: string) => address.trim().toLowerCase();

function attendeesOf(event: CalendarEventView | null, extra: StartRecording["attendees"]) {
  const all = new Map<string, string | null>();
  const add = (address: string, name: string | null) => {
    const key = lower(address);
    if (key && !all.get(key)) all.set(key, name?.trim() || null);
  };
  if (event?.organizer) add(event.organizer.address, event.organizer.name);
  for (const a of event?.attendees ?? []) add(a.address, a.name);
  for (const a of extra) add(a.address, a.name);
  return [...all].map(([address, name]) => ({ address, name }));
}

/** What `startMeeting` writes for a recording, its event resolved; `not_found` for a missing one. */
export async function resolveStart(
  db: Db,
  memberId: string,
  input: StartRecording,
  now = new Date(),
) {
  const found = await eventOf(db, memberId, input.event, now);
  if (found.status !== "ok") return { status: "event_not_found" } as const;
  const { event } = found;
  const attendees = attendeesOf(event, input.attendees);
  const groupKey =
    input.groupKey !== undefined
      ? (input.groupKey ?? "meeting:")
      : groupKeyFor({
          meetingId: "",
          eventUid: event?.uid ?? null,
          recurring: event?.recurring ?? false,
          attendees: attendees.map((a) => a.address),
          ownDomains: input.ownDomains ?? [],
        });
  return {
    status: "ok" as const,
    start: {
      title: input.title?.trim() || event?.title || null,
      event: event ? { uid: event.uid, recurrenceId: recurrenceKey(event.recurrenceId) } : null,
      attendees,
      groupKey: groupKey.startsWith("meeting:") ? null : groupKey,
      consent: input.consent,
    } satisfies StartMeeting,
  };
}
