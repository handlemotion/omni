import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  createTaskMutation,
  crmTaskCountsQuery,
  crmTaskQuery,
  crmTasksQuery,
  deleteTaskMutation,
  updateTaskMutation,
  type TaskFilter,
} from "../lib/crm-tasks.ts";
import { useMember } from "./use-session.ts";

/** Tasks matching `filter`; `tasks` is every loaded page. */
export function useCrmTasks(filter: TaskFilter) {
  const query = useInfiniteQuery(crmTasksQuery(filter));
  const tasks = useMemo(() => query.data?.pages.flatMap((page) => page.tasks) ?? [], [query.data]);
  return { ...query, tasks };
}

export function useCrmTask(id: string) {
  return useQuery(crmTaskQuery(id));
}

export function useCrmTaskCounts() {
  return useQuery(crmTaskCountsQuery());
}

export function useCreateTask() {
  return useMutation(createTaskMutation(useQueryClient()));
}

/** `mutate({ id, ...change })`; `done` shows at once on the task's page. */
export function useUpdateTask() {
  return useMutation(updateTaskMutation(useQueryClient(), useMember().member.id));
}

/** `mutate(id)`. */
export function useDeleteTask() {
  return useMutation(deleteTaskMutation(useQueryClient()));
}
