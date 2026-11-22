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
};

export const calendarsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.calendars(),
    queryFn: ({ signal }) => call(api.calendar.calendars.$get({}, { init: { signal } })),
    select: (body) => body.calendars,
  });

export const calendarEventsQuery = (from: Date, to: Date) =>
  queryOptions({
    queryKey: calendarKeys.window(from.toISOString(), to.toISOString()),
    queryFn: ({ signal }) =>
      call(
        api.calendar.events.$get(
          { query: { from: from.toISOString(), to: to.toISOString() } },
          { init: { signal } },
        ),
      ),
    select: (body) => body.events,
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

/** Shows a one-off event at its new time at once, before the write lands. */
export function placeEvent(client: QueryClient, id: string, start: string, end: string) {
  client.setQueriesData<EventWindow>({ queryKey: windows() }, (data) =>
    data
      ? {
          events: data.events.map((event) =>
            event.id === id && !event.recurrenceId ? { ...event, start, end } : event,
          ),
        }
      : data,
  );
}

export const updateEventMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (input: { id: string; change: CalendarEventChange }) =>
      call(api.calendar.events[":id"].$patch({ param: { id: input.id }, json: input.change })),
    onSettled: () => calendarChanged(client),
  });

export const deleteEventMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.calendar.events[":id"].$delete({ param: { id } })),
    onSettled: () => calendarChanged(client),
  });

export const calendarPrefsMutation = (client: QueryClient) =>
  mutationOptions({
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
