import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  answerMutation,
  attendeesInCrmQuery,
  calendarEventsQuery,
  calendarPrefsMutation,
  calendarsQuery,
  createEventMutation,
  deleteEventMutation,
  threadInvitesQuery,
  updateEventMutation,
  type CalendarEvent,
} from "@/lib/calendar.ts";
import { eventKey } from "@/lib/calendar-grid.ts";

export const useCalendars = () => useQuery(calendarsQuery());
export const useCalendarEvents = (from: Date, to: Date) =>
  useQuery({ ...calendarEventsQuery(from, to), placeholderData: (previous) => previous });
const joinWindows = (results: UseQueryResult<CalendarEvent[]>[]) => {
  const byKey = new Map<string, CalendarEvent>();
  for (const result of results) {
    for (const event of result.data ?? []) byKey.set(eventKey(event), event);
  }
  return {
    data: results.some((result) => result.data) ? [...byKey.values()] : undefined,
    isFetched: results.every((result) => result.isFetched),
  };
};

/** The events of several windows at once, each read and cached on its own, one copy of each. */
export const useCalendarWindows = (windows: readonly { from: Date; to: Date }[]) =>
  useQueries({
    queries: windows.map((window) => ({
      ...calendarEventsQuery(window.from, window.to),
      placeholderData: keepPreviousData,
    })),
    combine: joinWindows,
  });

export const useThreadInvites = (threadId: string) => useQuery(threadInvitesQuery(threadId));

export function useCalendarWrites() {
  const client = useQueryClient();
  return {
    answer: useMutation(answerMutation(client)),
    create: useMutation(createEventMutation(client)),
    update: useMutation(updateEventMutation(client)),
    remove: useMutation(deleteEventMutation(client)),
    prefs: useMutation(calendarPrefsMutation(client)),
  };
}

export const useAttendeesInCrm = (addresses: readonly string[], hasCrm: boolean) =>
  useQuery({ ...attendeesInCrmQuery(addresses), enabled: hasCrm && addresses.length > 0 });
