import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
} from "@/lib/calendar.ts";

export const useCalendars = () => useQuery(calendarsQuery());
export const useCalendarEvents = (from: Date, to: Date) =>
  useQuery({ ...calendarEventsQuery(from, to), placeholderData: (previous) => previous });
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
