import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  calendarTaskQuery,
  calendarTasksQuery,
  createCalendarTaskMutation,
  deleteCalendarTaskMutation,
  updateCalendarTaskMutation,
  type NewCalendarTask,
} from "../lib/calendar-tasks.ts";
import { pendingId } from "../lib/crm-pending.ts";
import { useMember } from "./use-session.ts";

/** The member's own and assigned tasks, open or done; `tasks` is every loaded page. */
export function useCalendarTasks(status: "open" | "done") {
  const query = useInfiniteQuery(calendarTasksQuery(status));
  const tasks = useMemo(() => query.data?.pages.flatMap((page) => page.tasks) ?? [], [query.data]);
  return { ...query, tasks };
}

export function useCalendarTask(id: string) {
  return useQuery(calendarTaskQuery(id));
}

/** `create(task, onError?)` shows the to-do at once and answers its pending id. */
export function useCreateCalendarTask() {
  const { member } = useMember();
  const mutation = useMutation(createCalendarTaskMutation(useQueryClient(), member.id));
  const { mutateAsync } = mutation;
  const create = useCallback(
    (task: NewCalendarTask, onError?: (error: unknown) => void) => {
      const id = pendingId();
      const made = mutateAsync({ ...task, pendingId: id });
      made.catch((error: unknown) => onError?.(error));
      return { id, made };
    },
    [mutateAsync],
  );
  return { ...mutation, create };
}

/** `mutate({ id, ...change })`. */
export function useUpdateCalendarTask() {
  return useMutation(updateCalendarTaskMutation(useQueryClient(), useMember().member.id));
}

/** `mutate(id)`. */
export function useDeleteCalendarTask() {
  return useMutation(deleteCalendarTaskMutation(useQueryClient()));
}
