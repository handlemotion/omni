import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { calendarTaskKeys } from "./calendar-tasks.ts";
import { settledId } from "./crm-pending.ts";
import { keys } from "./query-keys.ts";

/** Which door a task is read through: the CRM's for a task on a record, the calendar's for one's own. */
export type TaskSource = "crm" | "calendar";

type CalendarTaskActivityResponse = InferResponseType<
  Api["calendar"]["tasks"][":id"]["activity"]["$get"],
  200
>;
export type TaskActivityItem = CalendarTaskActivityResponse["items"][number];

/** Under the task's own key, so whatever refreshes the task refreshes its activity. */
export const taskActivityKey = (source: TaskSource, id: string) =>
  [...(source === "crm" ? keys.crmTask(id) : calendarTaskKeys.one(id)), "activity"] as const;

const routes = (source: TaskSource) =>
  source === "crm" ? api.crm.tasks[":id"] : api.calendar.tasks[":id"];

export const taskActivityQuery = (source: TaskSource, id: string) =>
  queryOptions({
    queryKey: taskActivityKey(source, id),
    queryFn: async ({ signal }) =>
      call(
        routes(source).activity.$get({ param: { id: await settledId(id) } }, { init: { signal } }),
      ),
    select: (data) => data.items,
  });

/**
 * `mutate(body)`: the comment shows at the end of the activity at once, under `self`, and comes
 * off again if the request fails.
 */
export const commentOnTaskMutation = (
  client: QueryClient,
  source: TaskSource,
  id: string,
  self: string | null,
) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: async (body: string) =>
      call(routes(source).comments.$post({ param: { id: await settledId(id) }, json: { body } })),
    onMutate: async (body) => {
      const key = taskActivityKey(source, id);
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<CalendarTaskActivityResponse>(key);
      const pending: TaskActivityItem = {
        id: `pending:${crypto.randomUUID()}`,
        kind: "comment",
        body: body.trim(),
        actorMemberId: self,
        at: new Date().toISOString(),
      };
      client.setQueryData<CalendarTaskActivityResponse>(key, {
        items: [...(before?.items ?? []), pending],
      });
      return { before };
    },
    onError: (_error, _body, context) =>
      client.setQueryData(taskActivityKey(source, id), context?.before),
    onSettled: () => client.invalidateQueries({ queryKey: taskActivityKey(source, id) }),
  });
