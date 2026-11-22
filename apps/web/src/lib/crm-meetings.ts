import { infiniteQueryOptions, mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { meetingsChanged } from "./meetings.ts";
import { keys } from "./query-keys.ts";

export type CrmRecordsKind = "companies" | "people" | "deals";

export type CrmMeeting = InferResponseType<
  (typeof api.crm.deals)[":id"]["meetings"]["$get"],
  200
>["meetings"][number];

const PAGE = 30;

/** A project's Meetings tab: its recorded meetings the member can open, newest first. */
export const dealMeetingsQuery = (dealId: string) =>
  infiniteQueryOptions({
    queryKey: [...keys.crm(), "meetings", dealId] as const,
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.deals[":id"].meetings.$get(
          {
            param: { id: dealId },
            query: { limit: String(PAGE), ...(pageParam ? { cursor: pageParam } : {}) },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.meetings),
  });

const settled = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: [...keys.crm(), "meetings"] }),
    client.invalidateQueries({ queryKey: [...keys.crm(), "timeline"] }),
    meetingsChanged(client),
  ]);

/** Puts a meeting on a record (`put`), or takes it off (`remove`), through the CRM's routes. */
export const placeMeetingMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (input: {
      records: CrmRecordsKind;
      id: string;
      meetingId: string;
      action: "put" | "remove";
    }) => {
      const route = api.crm[":records{companies|people|deals}"][":id"].meetings[":meetingId"];
      const param = { records: input.records, id: input.id, meetingId: input.meetingId };
      return call(input.action === "put" ? route.$put({ param }) : route.$delete({ param }));
    },
    onSettled: () => settled(client),
  });
