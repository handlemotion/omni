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
import { holdQueries, lastWrite, restoreQueries } from "./cache.ts";
import { currentId, pendingFailed, pendingMade, settledId } from "./crm-pending.ts";
import { closureAfter } from "./task-status.ts";
import { keys } from "./query-keys.ts";

type Tasks = Api["calendar"]["tasks"];
type Json<T> = T extends { json: infer J } ? J : never;

type CalendarTaskPage = InferResponseType<Tasks["$get"], 200>;
/** A task as the calendar holds it: private while `record` is null. */
export type CalendarTask = CalendarTaskPage["tasks"][number];
export type NewCalendarTask = Json<InferRequestType<Tasks["$post"]>>;
type CalendarTaskChange = Json<InferRequestType<Tasks[":id"]["$patch"]>>;
/** What the calendar draws of a to-do, whichever list it came from. */
export type Todo = Pick<CalendarTask, "id" | "title" | "dueAt" | "completedAt" | "record">;

type Status = "open" | "done";

/** Query keys for the member's own tasks, under the calendar's. */
export const calendarTaskKeys = {
  all: keys.calendarTasks,
  lists: keys.calendarTaskLists,
  list: keys.calendarTaskList,
  one: keys.calendarTask,
};

const fetchTasks = (status: Status, cursor: string | null, signal?: AbortSignal) =>
  call(
    api.calendar.tasks.$get(
      { query: { status, ...(cursor ? { cursor } : {}), limit: "100" } },
      { init: { signal } },
    ),
  );

export const calendarTasksQuery = (status: Status) =>
  infiniteQueryOptions({
    queryKey: calendarTaskKeys.list(status),
    queryFn: ({ pageParam, signal }) => fetchTasks(status, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** Asks for the open to-dos ahead of the calendar, only when none are cached. */
export const warmCalendarTasks = (client: QueryClient) =>
  client.prefetchInfiniteQuery({
    ...calendarTasksQuery("open"),
    queryFn: ({ pageParam }) => fetchTasks("open", pageParam),
    staleTime: Infinity,
  });

export const calendarTaskQuery = (id: string) =>
  queryOptions({
    queryKey: calendarTaskKeys.one(id),
    queryFn: async ({ signal }) =>
      call(
        api.calendar.tasks[":id"].$get(
          { param: { id: await settledId(id) } },
          { init: { signal } },
        ),
      ),
  });

const writes = () => [...calendarTaskKeys.all(), "write"] as const;

const settle = (client: QueryClient) => ({
  mutationKey: writes(),
  onSettled: () => {
    if (!lastWrite(client, writes())) return;
    void client.invalidateQueries({ queryKey: calendarTaskKeys.all() });
    void client.invalidateQueries({ queryKey: keys.crmTasks() });
  },
});

const hold = (client: QueryClient) => holdQueries(client, calendarTaskKeys.all());

type Pages = InfiniteData<CalendarTaskPage>;

function patchTask(client: QueryClient, id: string, change: (task: CalendarTask) => CalendarTask) {
  for (const [key, data] of client.getQueriesData<Pages>({ queryKey: calendarTaskKeys.lists() })) {
    if (!data) continue;
    client.setQueryData<Pages>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        tasks: page.tasks.map((task) => (task.id === id ? change(task) : task)),
      })),
    });
  }
  client.setQueryData<{ task: CalendarTask }>(calendarTaskKeys.one(id), (data) =>
    data ? { task: change(data.task) } : data,
  );
}

function dropTask(client: QueryClient, id: string) {
  for (const [key, data] of client.getQueriesData<Pages>({ queryKey: calendarTaskKeys.lists() })) {
    if (!data) continue;
    client.setQueryData<Pages>(key, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        tasks: page.tasks.filter((task) => task.id !== id),
      })),
    });
  }
}

const dueBefore = (task: CalendarTask, row: CalendarTask) =>
  task.dueAt !== null && (row.dueAt === null || Date.parse(row.dueAt) > Date.parse(task.dueAt));

function showOpen(client: QueryClient, task: CalendarTask) {
  const key = calendarTaskKeys.list("open");
  const data = client.getQueryData<Pages>(key);
  if (!data?.pages.length) return;
  const pages = data.pages.map((page) => ({ ...page, tasks: [...page.tasks] }));
  for (const page of pages) {
    const at = page.tasks.findIndex((row) => dueBefore(task, row));
    if (at === -1) continue;
    page.tasks.splice(at, 0, task);
    return void client.setQueryData<Pages>(key, { ...data, pages });
  }
  const last = pages.at(-1)!;
  if (last.nextCursor) return;
  last.tasks.push(task);
  client.setQueryData<Pages>(key, { ...data, pages });
}

/** A new private to-do, with the pending id (`pendingId()`) it shows under until the Worker answers. */
export type PendingCalendarTask = NewCalendarTask & { pendingId: string };

/** `mutate({ pendingId, ...task })`: the to-do shows at once, and takes the Worker's id when it answers. */
export const createCalendarTaskMutation = (client: QueryClient, self: string) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ pendingId: _pending, ...json }: PendingCalendarTask) =>
      call(api.calendar.tasks.$post({ json })),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: calendarTaskKeys.all() });
      const at = new Date().toISOString();
      const task: CalendarTask = {
        id: input.pendingId,
        title: input.title,
        body: input.body ?? null,
        subtasks: [],
        ownerMemberId: self,
        assigneeMemberId: self,
        record: null,
        status: "todo",
        priority: null,
        dueAt: input.dueAt ?? null,
        completedAt: null,
        completedByMemberId: null,
        createdByMemberId: self,
        createdAt: at,
        updatedAt: at,
      };
      showOpen(client, task);
      client.setQueryData(calendarTaskKeys.one(task.id), { task });
    },
    onSuccess: ({ task }, { pendingId }) => {
      pendingMade(pendingId, task.id);
      patchTask(client, pendingId, (shown) => ({ ...shown, id: task.id }));
      client.setQueryData(calendarTaskKeys.one(task.id), { task });
    },
    onError: (error, { pendingId }) => {
      pendingFailed(pendingId, error);
      dropTask(client, pendingId);
      client.removeQueries({ queryKey: calendarTaskKeys.one(pendingId) });
    },
    ...settle(client),
  });

/**
 * `mutate({ id, ...change })`: the change shows at once (a done to-do stays where it is, checked,
 * until the lists refetch), and comes off again if the request fails.
 */
export const updateCalendarTaskMutation = (client: QueryClient, self: string) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async ({
      id,
      linked,
      ...json
    }: CalendarTaskChange & { id: string; linked?: boolean }) => {
      const param = { id: await settledId(id) };
      if (linked) await call(api.crm.tasks[":id"].$patch({ param, json }));
      else await call(api.calendar.tasks[":id"].$patch({ param, json }));
    },
    onMutate: async ({ id, done, status, linked: _linked, ...change }) => {
      const snapshot = await hold(client);
      const defined = Object.fromEntries(
        Object.entries(change).filter(([, value]) => value !== undefined),
      );
      patchTask(client, currentId(id), (task) => ({
        ...task,
        ...defined,
        ...closureAfter(task, { done, status }, self),
      }));
      return { snapshot };
    },
    onError: (_error, _change, context) => restoreQueries(client, context?.snapshot),
    ...settle(client),
  });

/** `mutate(id)`: the to-do leaves every list at once, and comes back if the request fails. */
export const deleteCalendarTaskMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (id: string) =>
      call(api.calendar.tasks[":id"].$delete({ param: { id: await settledId(id) } })),
    onMutate: async (id) => {
      const snapshot = await hold(client);
      dropTask(client, currentId(id));
      return { snapshot };
    },
    onError: (_error, _id, context) => restoreQueries(client, context?.snapshot),
    ...settle(client),
  });
