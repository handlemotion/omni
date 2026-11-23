import {
  infiniteQueryOptions,
  type InfiniteData,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  recordFilter as filterForRecord,
  type Api,
  type CrmRecordKind,
  type CrmTask,
  type CrmTaskPage,
} from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { holdQueries, restoreQueries } from "./cache.ts";
import {
  dropCrmEntity,
  dropFromPages,
  findCrmEntity,
  patchCrmEntity,
  setCrmFields,
  settleCrm,
} from "./crm-cache.ts";
import { calendarTaskKeys } from "./calendar-tasks.ts";
import { currentId, pendingFailed, pendingMade, settledId } from "./crm-pending.ts";
import { keys } from "./query-keys.ts";

type Tasks = Api["crm"]["tasks"];
type Json<T> = T extends { json: infer J } ? J : never;

/** A task's place in the workspace: open beside everyone's tasks. */
export const taskPath = (id: string) => `/crm/tasks?assignee=anyone&task=${encodeURIComponent(id)}`;

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
    queryKey: keys.crmTaskList(clean(filter)),
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
    queryKey: keys.crmTask(id),
    queryFn: async ({ signal }) =>
      call(api.crm.tasks[":id"].$get({ param: { id: await settledId(id) } }, { init: { signal } })),
  });

export const crmTaskCountsQuery = () =>
  queryOptions({
    queryKey: keys.crmTaskCounts(),
    queryFn: ({ signal }) => call(api.crm.tasks.counts.$get(undefined, { init: { signal } })),
    select: (data) => data.counts,
  });

const settle = (client: QueryClient) =>
  settleCrm(client, () => client.invalidateQueries({ queryKey: calendarTaskKeys.all() }));

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
      await client.cancelQueries({ queryKey: keys.crmTasks() });
      const task = draftTask(client, input, self);
      showInLists(client, task, self);
      client.setQueryData(keys.crmTask(task.id), { task });
    },
    onSuccess: ({ task }, { pendingId }) => {
      pendingMade(pendingId, task.id);
      patchCrmEntity(client, pendingId, (shown) => ({ ...shown, ...madeFields(task) }));
      const shown = findCrmEntity(client, task.id) ?? task;
      client.setQueryData(keys.crmTask(task.id), { task: shown });
    },
    onError: (error, { pendingId }) => {
      pendingFailed(pendingId, error);
      dropCrmEntity(client, pendingId);
      client.removeQueries({ queryKey: keys.crmTask(pendingId) });
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
    queryKey: keys.crmTaskLists(),
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
      const snapshot = await holdQueries(client, keys.crm());
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
    onError: (_error, _change, context) => restoreQueries(client, context?.snapshot),
    ...settle(client),
  });

/** `mutate(id)`: the task leaves every list at once, and comes back if the request fails. */
export const deleteTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (id: string) =>
      call(api.crm.tasks[":id"].$delete({ param: { id: await settledId(id) } })),
    onMutate: async (id) => {
      const snapshot = await holdQueries(client, keys.crm());
      dropFromPages(client, keys.crmTaskLists(), "tasks", new Set([id, currentId(id)]));
      return { snapshot };
    },
    onError: (_error, _id, context) => restoreQueries(client, context?.snapshot),
    ...settle(client),
  });

export const recordFilter: (kind: CrmRecordKind, id: string) => TaskFilter = filterForRecord;

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
