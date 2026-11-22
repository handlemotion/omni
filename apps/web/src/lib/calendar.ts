import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Calendar = Api["calendar"];
type Json<T> = T extends { json: infer J } ? J : never;

export type CalendarList = InferResponseType<Calendar["calendars"]["$get"], 200>["calendars"];
export type CalendarItem = CalendarList[number];
export type CalendarEvent = InferResponseType<Calendar["events"]["$get"], 200>["events"][number];
export type CalendarInvite = InferResponseType<Calendar["invites"]["$get"], 200>["invites"][number];
export type NewCalendarEvent = Json<InferRequestType<Calendar["events"]["$post"]>>;
export type CalendarEventChange = Json<InferRequestType<Calendar["events"][":id"]["$patch"]>>;
export type CalendarAnswer = "accepted" | "declined" | "tentative";

export const calendarKeys = {
  all: () => keys.calendar(),
  calendars: () => [...calendarKeys.all(), "calendars"] as const,
  window: (from: string, to: string) => [...calendarKeys.all(), "events", from, to] as const,
  event: (id: string) => [...calendarKeys.all(), "event", id] as const,
  invites: (threadId: string) => [...calendarKeys.all(), "invites", threadId] as const,
  /** Every write's mutation: while one is in flight, a refetch could show what it replaces. */
  writes: () => [...calendarKeys.all(), "write"] as const,
};

export const calendarsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.calendars(),
    queryFn: ({ signal }) => call(api.calendar.calendars.$get({}, { init: { signal } })),
    select: (body) => body.calendars,
  });

const fetchWindow = (from: Date, to: Date, signal?: AbortSignal) =>
  call(
    api.calendar.events.$get(
      { query: { from: from.toISOString(), to: to.toISOString() } },
      { init: { signal } },
    ),
  );

export const calendarEventsQuery = (from: Date, to: Date) =>
  queryOptions({
    queryKey: calendarKeys.window(from.toISOString(), to.toISOString()),
    queryFn: ({ signal }) => fetchWindow(from, to, signal),
    select: (body) => body.events,
  });

/**
 * Asks for a window ahead of time, only when nothing of it is cached (one cached, even stale,
 * shows at once and is checked when shown). It is not cancelled when a page showing it unmounts,
 * so the page that mounts next takes this answer rather than asking again.
 */
export const warmCalendarWindow = (client: QueryClient, from: Date, to: Date) =>
  client.prefetchQuery({
    ...calendarEventsQuery(from, to),
    queryFn: () => fetchWindow(from, to),
    staleTime: Infinity,
  });

export const calendarEventQuery = (id: string) =>
  queryOptions({
    queryKey: calendarKeys.event(id),
    queryFn: ({ signal }) =>
      call(api.calendar.events[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const threadInvitesQuery = (threadId: string) =>
  queryOptions({
    queryKey: calendarKeys.invites(threadId),
    queryFn: ({ signal }) =>
      call(api.calendar.invites.$get({ query: { thread: threadId } }, { init: { signal } })),
    select: (body) => body.invites,
  });

/** Every calendar read is stale after a write or a `calendar.changed`. */
export const calendarChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: calendarKeys.all() });

export const answerMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: calendarKeys.writes(),
    mutationFn: (input: { id: string; response: CalendarAnswer }) =>
      call(
        api.calendar.events[":id"].answer.$post({
          param: { id: input.id },
          json: { response: input.response },
        }),
      ),
    onSettled: () => calendarChanged(client),
  });

export const createEventMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: calendarKeys.writes(),
    mutationFn: (json: NewCalendarEvent) => call(api.calendar.events.$post({ json })),
    onSettled: () => calendarChanged(client),
  });

type EventWindow = { events: CalendarEvent[] };
const windows = () => [...calendarKeys.all(), "events"] as const;

/** Where a one-off event is now, as the grid shows it, counting moves still on their way. */
export const eventTimesNow = (client: QueryClient, id: string) => {
  let newest: { start: string; end: string; at: number } | null = null;
  for (const query of client.getQueryCache().findAll({ queryKey: windows() })) {
    const data = query.state.data as EventWindow | undefined;
    const found = data?.events.find((event) => event.id === id && !event.recurrenceId);
    if (found && (!newest || query.state.dataUpdatedAt > newest.at)) {
      newest = { start: found.start, end: found.end, at: query.state.dataUpdatedAt };
    }
  }
  return newest && { start: newest.start, end: newest.end };
};

const DAY_MS = 86_400_000;

function shiftDay(key: string | null, days: number) {
  if (!key) return key;
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function moved(event: CalendarEvent, start: string, end: string) {
  if (!event.allDay) return { ...event, start, end } satisfies CalendarEvent;
  const days = Math.round((Date.parse(start) - Date.parse(event.start)) / DAY_MS);
  return {
    ...event,
    start,
    end,
    startDay: shiftDay(event.startDay, days),
    endDay: shiftDay(event.endDay, days),
  };
}

/** Shows a one-off event at its new time (and an all-day one on its new days) at once, before the write lands. */
export function placeEvent(client: QueryClient, id: string, start: string, end: string) {
  client.setQueriesData<EventWindow>({ queryKey: windows() }, (data) =>
    data
      ? {
          events: data.events.map((event) =>
            event.id === id && !event.recurrenceId ? moved(event, start, end) : event,
          ),
        }
      : data,
  );
}

export const updateEventMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: calendarKeys.writes(),
    mutationFn: (input: { id: string; change: CalendarEventChange }) =>
      call(api.calendar.events[":id"].$patch({ param: { id: input.id }, json: input.change })),
    onSettled: () => calendarChanged(client),
  });

export const deleteEventMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: calendarKeys.writes(),
    mutationFn: (id: string) => call(api.calendar.events[":id"].$delete({ param: { id } })),
    onSettled: () => calendarChanged(client),
  });

export const calendarPrefsMutation = (client: QueryClient) =>
  mutationOptions({
    mutationKey: calendarKeys.writes(),
    mutationFn: (input: { id: string; hidden?: boolean; color?: string | null }) =>
      call(
        api.calendar.calendars[":id"].$patch({
          param: { id: input.id },
          json: { hidden: input.hidden, color: input.color },
        }),
      ),
    onSettled: () => calendarChanged(client),
  });

/** A calendar's color when its person picked none: the chart palette, in the calendar's order. */
export const calendarTone = (calendars: readonly CalendarItem[], calendarId: string) => {
  const picked = calendars.find((c) => c.id === calendarId)?.color;
  if (picked) return picked;
  const index = Math.max(
    0,
    calendars.findIndex((c) => c.id === calendarId),
  );
  return `var(--chart-${(index % 5) + 1})`;
};

/** The CRM people, companies and deals an event's attendees are (`GET /api/crm/lookup`). */
export const attendeesInCrmQuery = (addresses: readonly string[]) =>
  queryOptions({
    queryKey: [...calendarKeys.all(), "crm", [...addresses].toSorted()] as const,
    queryFn: ({ signal }) =>
      call(
        api.crm.lookup.$get(
          { query: { address: addresses.slice(0, 50).join(",") } },
          { init: { signal } },
        ),
      ),
    enabled: addresses.length > 0,
  });
