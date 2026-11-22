import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  createTaskMutation,
  crmTaskCountsQuery,
  crmTaskQuery,
  crmTasksQuery,
  deleteTaskMutation,
  updateTaskMutation,
  type NewTask,
  type TaskFilter,
} from "../lib/crm-tasks.ts";
import { pendingId } from "../lib/crm-pending.ts";
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

/**
 * `create(task, onError?)` shows the task at once and answers its pending id; `made` settles with
 * the Worker's task. `onError` runs even once the caller has unmounted (a dialog that closed).
 */
export function useCreateTask() {
  const { member } = useMember();
  const mutation = useMutation(createTaskMutation(useQueryClient(), member.id));
  const { mutateAsync } = mutation;
  const create = useCallback(
    (task: NewTask, onError?: (error: unknown) => void) => {
      const id = pendingId();
      const made = mutateAsync({ ...task, pendingId: id });
      made.catch((error: unknown) => onError?.(error));
      return { id, made };
    },
    [mutateAsync],
  );
  return { ...mutation, create };
}

/** `mutate({ id, ...change })`; `done` shows at once on the task's page. */
export function useUpdateTask() {
  return useMutation(updateTaskMutation(useQueryClient(), useMember().member.id));
}

/** `mutate(id)`. */
export function useDeleteTask() {
  return useMutation(deleteTaskMutation(useQueryClient()));
}
