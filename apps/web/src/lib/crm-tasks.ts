import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import type { CrmRecordKind } from "./crm.ts";
import { dropFromPages, holdCrm, restoreCrm, setCrmFields, settleCrm } from "./crm-cache.ts";
import { keys } from "./query-keys.ts";

type Tasks = Api["crm"]["tasks"];
type Json<T> = T extends { json: infer J } ? J : never;

/** A task's place in the workspace: open beside everyone's tasks. */
export const taskPath = (id: string) => `/crm/tasks?assignee=anyone&task=${encodeURIComponent(id)}`;

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

/** Query keys for tasks: every list, one list, one task. */
export const taskKeys = {
  all: () => [...keys.crm(), "tasks"] as const,
  lists: () => [...keys.crm(), "tasks", "list"] as const,
  list: (filter: TaskFilter) => [...keys.crm(), "tasks", "list", filter] as const,
  one: (id: string) => [...keys.crm(), "tasks", "one", id] as const,
  counts: () => [...keys.crm(), "tasks", "counts"] as const,
};

const clean = (filter: TaskFilter) =>
  Object.fromEntries(Object.entries(filter).filter(([, value]) => value)) as TaskFilter;

const fetchTasks = (filter: TaskFilter, cursor: string | null, signal?: AbortSignal) =>
  call(
    api.crm.tasks.$get(
      { query: { ...clean(filter), ...(cursor ? { cursor } : {}), limit: "100" } },
      { init: { signal } },
    ),
  );

export const crmTasksQuery = (filter: TaskFilter) =>
  infiniteQueryOptions({
    queryKey: taskKeys.list(clean(filter)),
    queryFn: ({ pageParam, signal }) => fetchTasks(filter, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/**
 * Asks for a task list's first page ahead of time, only when none is cached. It is not cancelled
 * when a page showing it unmounts, so the page that mounts next takes this answer.
 */
export const warmCrmTasks = (client: QueryClient, filter: TaskFilter) =>
  client.prefetchInfiniteQuery({
    ...crmTasksQuery(filter),
    queryFn: ({ pageParam }) => fetchTasks(filter, pageParam),
    staleTime: Infinity,
  });

/** The member's own open to-dos, as the calendar shows them. */
export const MY_TODOS = { status: "open", assignee: "me" } satisfies TaskFilter;

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

const settle = (client: QueryClient) => settleCrm(client);

export const createTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewTask) => call(api.crm.tasks.$post({ json })),
    ...settle(client),
  });

/**
 * `mutate({ id, ...change })`: the change shows on the task and in every list at once (a done task
 * stays where it is, checked, until the lists refetch), and comes off again if the request fails.
 * `completedBy` is who checks it off.
 */
export const updateTaskMutation = (client: QueryClient, completedBy: string | null = null) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: TaskChange & { id: string }) =>
      call(api.crm.tasks[":id"].$patch({ param: { id }, json })),
    onMutate: async ({ id, done, ...change }) => {
      const snapshot = await holdCrm(client);
      setCrmFields(client, id, {
        title: change.title,
        body: change.body,
        subtasks: change.subtasks,
        assigneeMemberId: change.assigneeMemberId,
        dueAt: change.dueAt,
        ...(done === undefined
          ? {}
          : {
              completedAt: done ? new Date().toISOString() : null,
              completedByMemberId: done ? completedBy : null,
            }),
      });
      return { snapshot };
    },
    onError: (_error, _change, context) => restoreCrm(client, context?.snapshot),
    ...settle(client),
  });

/** `mutate(id)`: the task leaves every list at once, and comes back if the request fails. */
export const deleteTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.tasks[":id"].$delete({ param: { id } })),
    onMutate: async (id) => {
      const snapshot = await holdCrm(client);
      dropFromPages(client, taskKeys.lists(), "tasks", new Set([id]));
      return { snapshot };
    },
    onError: (_error, _id, context) => restoreCrm(client, context?.snapshot),
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
  if (task.companyId) {
    return { kind: "companies" as const, id: task.companyId, name, domain: task.recordDomain };
  }
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

/**
 * The due time a task takes when dropped on `group`: the end of today, of tomorrow, or none.
 * Undefined when the drop changes nothing: an open task can't be moved into Overdue, and a task
 * already in the group keeps its own day.
 */
export function dueOnDrop(task: CrmTask, group: DueGroup, now = new Date()) {
  if (group === "overdue" || dueGroup(task, now) === group) return undefined;
  if (group === "none") return null;
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (group === "today" ? 0 : 1),
    12,
  );
  return dueAtOf(dayOf(day.toISOString()));
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
