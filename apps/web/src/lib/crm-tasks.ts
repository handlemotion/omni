import {
  infiniteQueryOptions,
  type InfiniteData,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import type { CrmRecordKind } from "./crm.ts";
import {
  dropCrmEntity,
  dropFromPages,
  findCrmEntity,
  holdCrm,
  patchCrmEntity,
  restoreCrm,
  setCrmFields,
  settleCrm,
} from "./crm-cache.ts";
import { currentId, pendingFailed, pendingMade, settledId } from "./crm-pending.ts";
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
    queryFn: async ({ signal }) =>
      call(api.crm.tasks[":id"].$get({ param: { id: await settledId(id) } }, { init: { signal } })),
  });

export const crmTaskCountsQuery = () =>
  queryOptions({
    queryKey: taskKeys.counts(),
    queryFn: ({ signal }) => call(api.crm.tasks.counts.$get(undefined, { init: { signal } })),
    select: (data) => data.counts,
  });

const settle = (client: QueryClient) => settleCrm(client);

/** A new task, with the pending id (`pendingId()`) its row shows under until the Worker answers. */
export type PendingTask = NewTask & { pendingId: string };

/**
 * `mutate({ pendingId, ...task })`: the task shows at once in every cached list it fits and under
 * its pending id; once the Worker answers it takes the Worker's id, and a failure takes it out.
 * `self` is the member creating it, its assignee unless the task names another.
 */
export const createTaskMutation = (client: QueryClient, self: string | null = null) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ pendingId: _pending, ...json }: PendingTask) =>
      call(api.crm.tasks.$post({ json })),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: taskKeys.all() });
      const task = draftTask(client, input, self);
      showInLists(client, task, self);
      client.setQueryData(taskKeys.one(task.id), { task });
    },
    onSuccess: ({ task }, { pendingId }) => {
      pendingMade(pendingId, task.id);
      patchCrmEntity(client, pendingId, (shown) => ({ ...shown, ...madeFields(task) }));
      const shown = findCrmEntity(client, task.id) ?? task;
      client.setQueryData(taskKeys.one(task.id), { task: shown });
    },
    onError: (error, { pendingId }) => {
      pendingFailed(pendingId, error);
      dropCrmEntity(client, pendingId);
      client.removeQueries({ queryKey: taskKeys.one(pendingId) });
    },
    ...settle(client),
  });

const madeFields = (task: CrmTask) => ({
  id: task.id,
  recordName: task.recordName,
  recordDomain: task.recordDomain,
  createdByMemberId: task.createdByMemberId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

function draftTask(client: QueryClient, input: PendingTask, self: string | null) {
  const at = new Date().toISOString();
  const recordId = input.companyId ?? input.personId ?? input.dealId ?? null;
  const record = recordId ? findCrmEntity(client, recordId) : undefined;
  return {
    id: input.pendingId,
    title: input.title,
    body: input.body ?? null,
    subtasks: [],
    companyId: input.companyId ?? null,
    personId: input.personId ?? null,
    dealId: input.dealId ?? null,
    recordName: typeof record?.name === "string" ? record.name : null,
    recordDomain: typeof record?.domain === "string" ? record.domain : null,
    ownerMemberId: self,
    assigneeMemberId: input.assigneeMemberId === undefined ? self : input.assigneeMemberId,
    dueAt: input.dueAt ?? null,
    completedAt: null,
    completedByMemberId: null,
    createdByMemberId: self,
    createdAt: at,
    updatedAt: at,
  } satisfies CrmTask;
}

/** Whether `task` belongs in the list `filter` asks for, as the Worker would answer it. */
export function fitsFilter(
  filter: TaskFilter,
  task: CrmTask,
  self: string | null,
  now = Date.now(),
) {
  if ((filter.status === "done") !== !!task.completedAt) return false;
  if (filter.assignee) {
    const assignee =
      filter.assignee === "me" ? self : filter.assignee === "none" ? null : filter.assignee;
    if (task.assigneeMemberId !== assignee) return false;
  }
  if (!task.completedAt && !dueFits(filter.due, task.dueAt, now)) return false;
  if (filter.company && task.companyId !== filter.company) return false;
  if (filter.person && task.personId !== filter.person) return false;
  if (filter.deal && task.dealId !== filter.deal) return false;
  const title = task.title.toLowerCase();
  const words = (filter.q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((word) => title.includes(word));
}

function dueFits(due: TaskFilter["due"], dueAt: string | null, now: number) {
  const at = dueAt ? Date.parse(dueAt) : null;
  if (due === "none") return at === null;
  if (due === "overdue") return at !== null && at < now;
  if (due === "upcoming") return at !== null && at >= now;
  return true;
}

const dueBefore = (task: CrmTask, row: CrmTask) =>
  task.dueAt !== null && (row.dueAt === null || Date.parse(row.dueAt) > Date.parse(task.dueAt));

function showInLists(client: QueryClient, task: CrmTask, self: string | null) {
  for (const [key, data] of client.getQueriesData<InfiniteData<CrmTaskPage>>({
    queryKey: taskKeys.lists(),
  })) {
    const filter = key.at(-1) as TaskFilter;
    if (!data?.pages.length || !fitsFilter(filter, task, self)) continue;
    if (data.pages.some((page) => page.tasks.some((row) => row.id === task.id))) continue;
    client.setQueryData(key, placeTask(data, task));
  }
}

function placeTask(data: InfiniteData<CrmTaskPage>, task: CrmTask) {
  const pages = data.pages.map((page) => ({ ...page, tasks: [...page.tasks] }));
  const before = task.completedAt ? () => true : (row: CrmTask) => dueBefore(task, row);
  for (const page of pages) {
    const at = page.tasks.findIndex(before);
    if (at === -1) continue;
    page.tasks.splice(at, 0, task);
    return { ...data, pages };
  }
  const last = pages.at(-1)!;
  if (last.nextCursor) return data;
  last.tasks.push(task);
  return { ...data, pages };
}

/**
 * `mutate({ id, ...change })`: the change shows on the task and in every list at once (a done task
 * stays where it is, checked, until the lists refetch), and comes off again if the request fails.
 * `completedBy` is who checks it off.
 */
export const updateTaskMutation = (client: QueryClient, completedBy: string | null = null) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async ({ id, ...json }: TaskChange & { id: string }) =>
      call(api.crm.tasks[":id"].$patch({ param: { id: await settledId(id) }, json })),
    onMutate: async ({ id, done, ...change }) => {
      const snapshot = await holdCrm(client);
      setCrmFields(client, currentId(id), {
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
      const task = findCrmEntity(client, currentId(id)) as CrmTask | undefined;
      if (task) showInLists(client, task, completedBy);
      return { snapshot };
    },
    onError: (_error, _change, context) => restoreCrm(client, context?.snapshot),
    ...settle(client),
  });

/** `mutate(id)`: the task leaves every list at once, and comes back if the request fails. */
export const deleteTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (id: string) =>
      call(api.crm.tasks[":id"].$delete({ param: { id: await settledId(id) } })),
    onMutate: async (id) => {
      const snapshot = await holdCrm(client);
      dropFromPages(client, taskKeys.lists(), "tasks", new Set([id, currentId(id)]));
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
