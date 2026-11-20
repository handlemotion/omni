import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { crmChanged, type CrmRecordKind } from "./crm.ts";
import { keys } from "./query-keys.ts";

type Tasks = Api["crm"]["tasks"];
type Json<T> = T extends { json: infer J } ? J : never;

export type CrmTaskPage = InferResponseType<Tasks["$get"], 200>;
export type CrmTask = CrmTaskPage["tasks"][number];
export type CrmTaskCounts = InferResponseType<Tasks["counts"]["$get"], 200>["counts"];
export type NewTask = Json<InferRequestType<Tasks["$post"]>>;
export type TaskChange = Json<InferRequestType<Tasks[":id"]["$patch"]>>;

/** What a tasks list asks for: the API's filters, as the page's search params name them. */
export interface TaskFilter {
  status?: "open" | "done";
  assignee?: string;
  due?: "overdue" | "upcoming" | "none";
  company?: string;
  person?: string;
  deal?: string;
  q?: string;
}

const taskKeys = {
  all: () => [...keys.crm(), "tasks"] as const,
  list: (filter: TaskFilter) => [...keys.crm(), "tasks", "list", filter] as const,
  one: (id: string) => [...keys.crm(), "tasks", "one", id] as const,
  counts: () => [...keys.crm(), "tasks", "counts"] as const,
};

const clean = (filter: TaskFilter) =>
  Object.fromEntries(Object.entries(filter).filter(([, value]) => value)) as TaskFilter;

export const crmTasksQuery = (filter: TaskFilter) =>
  infiniteQueryOptions({
    queryKey: taskKeys.list(clean(filter)),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.tasks.$get(
          {
            query: { ...clean(filter), ...(pageParam ? { cursor: pageParam } : {}), limit: "100" },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const crmTaskQuery = (id: string) =>
  queryOptions({
    queryKey: taskKeys.one(id),
    queryFn: ({ signal }) =>
      call(api.crm.tasks[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const crmTaskCountsQuery = () =>
  queryOptions({
    queryKey: taskKeys.counts(),
    queryFn: ({ signal }) => call(api.crm.tasks.counts.$get(undefined, { init: { signal } })),
    select: (data) => data.counts,
  });

const settle = (client: QueryClient) => ({ onSettled: () => crmChanged(client) });

export const createTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewTask) => call(api.crm.tasks.$post({ json })),
    ...settle(client),
  });

export const updateTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: TaskChange & { id: string }) =>
      call(api.crm.tasks[":id"].$patch({ param: { id }, json })),
    onMutate: async ({ id, done }) => {
      if (done === undefined) return;
      await client.cancelQueries({ queryKey: taskKeys.all() });
      const completedAt = done ? new Date().toISOString() : null;
      client.setQueryData(taskKeys.one(id), (data: { task: CrmTask } | undefined) =>
        data ? { task: { ...data.task, completedAt } } : data,
      );
    },
    ...settle(client),
  });

export const deleteTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.tasks[":id"].$delete({ param: { id } })),
    ...settle(client),
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

/** The record a task is on, as a link names it. */
export function taskRecord(task: CrmTask) {
  const name = task.recordName ?? "";
  if (task.companyId) return { kind: "companies" as const, id: task.companyId, name };
  if (task.personId) return { kind: "people" as const, id: task.personId, name };
  if (task.dealId) return { kind: "deals" as const, id: task.dealId, name };
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in this device's time zone, for a date input. */
export function dayOf(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A picked day as the moment the API stores: the end of that day here. */
export function dueAtOf(day: string) {
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!, 23, 59, 59, 999).toISOString();
}

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

/** "Today", "Tomorrow", "Mar 4", or with the year when it isn't this year. */
export function dueLabel(iso: string | null, now = new Date()) {
  if (!iso) return null;
  const date = new Date(iso);
  const today = dayOf(now.toISOString());
  const shifted = (days: number) =>
    dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12).toISOString());
  const tomorrow = shifted(1);
  const yesterday = shifted(-1);
  const day = dayOf(iso);
  if (day === today) return "Today";
  if (day === tomorrow) return "Tomorrow";
  if (day === yesterday) return "Yesterday";
  return (date.getFullYear() === now.getFullYear() ? SHORT : LONG).format(date);
}
