import type { Api } from "@omni/client";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type MutateOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call, inWorkspace } from "./api.ts";
import { crmChanged, type CrmRecordKind } from "./crm-mutations.ts";
import { keys } from "./query-keys.ts";
import { cacheEpoch, currentWorkspaceId } from "./workspace-id.ts";

type Tasks = Api["crm"]["tasks"];
type Json<T> = T extends { json: infer J } ? J : never;
type TaskPage = InferResponseType<Tasks["$get"], 200>;
export type CrmTask = TaskPage["tasks"][number];
export type NewTask = Json<InferRequestType<Tasks["$post"]>>;
export type TaskChange = Json<InferRequestType<Tasks[":id"]["$patch"]>>;

/** What a tasks list asks for, as the API's filters name it. */
export interface TaskFilter {
  status?: "open" | "done";
  assignee?: string;
  company?: string;
  person?: string;
  deal?: string;
}

/** The Tasks page's views, as the web's toggle names them. */
export const TASK_VIEWS = {
  mine: { label: "Mine", filter: { status: "open", assignee: "me" } },
  all: { label: "All", filter: { status: "open" } },
  done: { label: "Done", filter: { status: "done" } },
} as const satisfies Record<string, { label: string; filter: TaskFilter }>;

export type TaskView = keyof typeof TASK_VIEWS;

export const useTasks = (filter: TaskFilter) =>
  useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmTasks(filter),
      queryFn: ({ pageParam, signal }) =>
        call(
          api.crm.tasks.$get(
            { query: { ...filter, limit: "100", ...(pageParam ? { cursor: pageParam } : {}) } },
            { init: { signal } },
          ),
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((page) => page.tasks),
    }),
  );

export const useTask = (id: string) =>
  useQuery({
    queryKey: keys.crmTask(id),
    queryFn: ({ signal }) =>
      call(api.crm.tasks[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const useTaskCounts = () =>
  useQuery({
    queryKey: keys.crmTaskCounts(),
    queryFn: ({ signal }) => call(api.crm.tasks.counts.$get(undefined, { init: { signal } })),
    select: (data) => data.counts,
  });

/** The filter for a record's own tasks. */
export const recordFilter = (kind: CrmRecordKind, id: string) =>
  (kind === "companies"
    ? { company: id }
    : kind === "people"
      ? { person: id }
      : { deal: id }) satisfies TaskFilter as TaskFilter;

/** The record fields of a new task on `kind`/`id`. */
export const onRecord = (kind: CrmRecordKind, id: string) =>
  kind === "companies" ? { companyId: id } : kind === "people" ? { personId: id } : { dealId: id };

/** The record a task is on, as a screen's route names it. */
export function taskRecord(task: CrmTask) {
  const name = task.recordName ?? "";
  if (task.companyId) return { pathname: "/crm/company/[id]" as const, id: task.companyId, name };
  if (task.personId) return { pathname: "/crm/person/[id]" as const, id: task.personId, name };
  if (task.dealId) return { pathname: "/crm/deal/[id]" as const, id: task.dealId, name };
  return null;
}

type Named = { workspace: string | null };

const inOrder = { id: "crm-tasks" };

function named<R, V>(mutation: UseMutationResult<R, Error, V & Named, unknown>) {
  return {
    ...mutation,
    mutate: (vars: V, options?: MutateOptions<R, Error, V & Named, unknown>) =>
      mutation.mutate({ ...vars, workspace: currentWorkspaceId() }, options),
  };
}

export const useCreateTask = () => {
  const client = useQueryClient();
  return named(
    useMutation({
      mutationFn: ({ workspace, ...json }: NewTask & Named) =>
        call(api.crm.tasks.$post({ json }, inWorkspace(workspace))),
      onSettled: () => crmChanged(client),
    }),
  );
};

/**
 * `mutate({ id, ...change })` changes a task. Checking one off or reopening it shows at once in
 * every list and on its screen; the request's failure puts it back. Changes queue behind each
 * other, so a quick check-then-uncheck lands in that order.
 */
export function useUpdateTask() {
  const client = useQueryClient();
  return named(
    useMutation({
      mutationFn: ({ id, workspace, ...json }: TaskChange & { id: string } & Named) =>
        call(api.crm.tasks[":id"].$patch({ param: { id }, json }, inWorkspace(workspace))),
      scope: inOrder,
      onMutate: async ({ id, done }) => {
        if (done === undefined) return;
        const lists = ["crm", "tasks"];
        await client.cancelQueries({ queryKey: lists });
        const before = client.getQueriesData({ queryKey: lists });
        const completedAt = done ? new Date().toISOString() : null;
        const flip = (task: CrmTask) => (task.id === id ? { ...task, completedAt } : task);
        client.setQueriesData<InfiniteData<TaskPage> | { task: CrmTask }>(
          { queryKey: lists },
          (data) => {
            if (!data) return data;
            if ("task" in data) return { task: flip(data.task) };
            if (!("pages" in data)) return data;
            return { ...data, pages: data.pages.map((p) => ({ ...p, tasks: p.tasks.map(flip) })) };
          },
        );
        return { before, epoch: cacheEpoch() };
      },
      onError: (_error, _change, context) => {
        if (!context || context.epoch !== cacheEpoch()) return;
        for (const [key, data] of context.before) client.setQueryData(key, data);
      },
      onSettled: () => crmChanged(client),
    }),
  );
}

/** `mutate({ id })` deletes a task. */
export const useDeleteTask = () => {
  const client = useQueryClient();
  return named(
    useMutation({
      mutationFn: ({ id, workspace }: { id: string } & Named) =>
        call(api.crm.tasks[":id"].$delete({ param: { id } }, inWorkspace(workspace))),
      scope: inOrder,
      onSettled: () => crmChanged(client),
    }),
  );
};

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in this device's time zone. */
export function dayOf(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The moment the API stores for a day `days` from today: the end of that day here. */
export function dueIn(days: number, now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 59, 999);
  return date.toISOString();
}

/** The due dates a task's menu offers, as Reminders offers them. */
export const DUE_CHOICES = [
  { label: "Today", days: 0, icon: "calendar" },
  { label: "Tomorrow", days: 1, icon: "sunrise" },
  { label: "Next week", days: 7, icon: "calendar.badge.clock" },
] as const;

export type DueGroup = "overdue" | "today" | "upcoming" | "none";

export const DUE_GROUPS: { id: DueGroup; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "none", label: "No due date" },
];

/** Where an open task falls by its due time, in this device's day. */
export function dueGroup(task: CrmTask, now = new Date()) {
  let group: DueGroup = "upcoming";
  if (!task.dueAt) group = "none";
  else if (new Date(task.dueAt) < now) group = "overdue";
  else if (dayOf(task.dueAt) === dayOf(now.toISOString())) group = "today";
  return group;
}

const SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const LONG = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Today", "Tomorrow", "Yesterday", "Mar 4", or with the year when it isn't this year. */
export function dueLabel(iso: string | null, now = new Date()) {
  if (!iso) return null;
  const day = dayOf(iso);
  const shifted = (days: number) =>
    dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12).toISOString());
  if (day === shifted(0)) return "Today";
  if (day === shifted(1)) return "Tomorrow";
  if (day === shifted(-1)) return "Yesterday";
  const date = new Date(iso);
  return (date.getFullYear() === now.getFullYear() ? SHORT : LONG).format(date);
}

/** An open task whose due time has passed. */
export const isOverdue = (task: CrmTask, now = new Date()) =>
  !task.completedAt && !!task.dueAt && new Date(task.dueAt) < now;
