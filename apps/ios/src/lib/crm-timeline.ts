import type { Api } from "@omni/client";
import { infiniteQueryOptions, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { ApiError, api, auth, call } from "./api.ts";
import type { CrmRecordKind } from "./crm-mutations.ts";
import { keys } from "./query-keys.ts";
import { useWorkspace } from "./workspace.ts";

type Crm = Api["crm"];
export type CrmStage = InferResponseType<Crm["stages"]["$get"], 200>["stages"][number];
type TimelinePage = InferResponseType<Crm["companies"][":id"]["timeline"]["$get"], 200>;
export type CrmTimelineItem = TimelinePage["items"][number];
type EventItem = Extract<CrmTimelineItem, { kind: "event" }>["event"];
type ContractItem = Extract<CrmTimelineItem, { kind: "contract" }>["contract"];

/** The pipeline, in order: what a deal can move to. */
export const useStages = () =>
  useQuery({
    queryKey: keys.crmStages(),
    queryFn: ({ signal }) => call(api.crm.stages.$get({}, { init: { signal } })),
    select: (data) => [...data.stages].sort((a, b) => a.position - b.position),
    staleTime: 5 * 60_000,
  });

const timelineRoute = (kind: CrmRecordKind) =>
  kind === "companies"
    ? api.crm.companies[":id"].timeline
    : kind === "people"
      ? api.crm.people[":id"].timeline
      : api.crm.deals[":id"].timeline;

const KNOWN_KINDS = new Set(["event", "note", "contract", "thread", "activity"]);

/** A record's timeline, newest first. Items of a kind this app does not know are dropped. */
export const timelineQuery = (kind: CrmRecordKind, id: string) =>
  infiniteQueryOptions({
    queryKey: keys.crmTimeline(kind, id),
    queryFn: async ({ pageParam, signal }) => {
      const page = await call(
        timelineRoute(kind).$get(
          { param: { id }, query: pageParam ? { cursor: pageParam } : {} },
          { init: { signal } },
        ),
      );
      const items = page.items.filter((item) => KNOWN_KINDS.has(item.kind));
      return { items, nextCursor: page.nextCursor };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.items),
  });

export const useTimeline = (kind: CrmRecordKind, id: string) =>
  useInfiniteQuery(timelineQuery(kind, id));

/** Your member in this workspace: notes you wrote are yours to edit and delete. */
export const useMe = () =>
  useQuery({
    queryKey: keys.crmMe(),
    queryFn: ({ signal }) => call(api.me.$get({}, { init: { signal } })),
    staleTime: Infinity,
  });

/** The workspace's members by id, as names, for who did what on a timeline. */
export function useMemberNames() {
  const workspace = useWorkspace().active?.id;
  return useQuery({
    queryKey: keys.crmMembers(),
    queryFn: async ({ signal }) => {
      const { data, error } = await auth.organization.listMembers({
        query: { organizationId: workspace },
        fetchOptions: { signal },
      });
      if (error) throw new ApiError(error.status, error.message ?? "members didn't load");
      return data;
    },
    select: (data) => new Map(data.members.map((m) => [m.id, m.user.name || m.user.email])),
    enabled: !!workspace,
    staleTime: 5 * 60_000,
  });
}

/** What a change event says after its actor's name, as the web timeline says it. */
export function eventText(event: EventItem, stages: CrmStage[] | undefined) {
  const data = event.data;
  const text = (key: string) => (typeof data[key] === "string" ? data[key] : "");
  switch (event.kind) {
    case "created":
      return "created this";
    case "updated":
      return "edited the details";
    case "archived":
      return "archived this";
    case "restored":
      return "restored this";
    case "stage_moved": {
      const stage = stages?.find((s) => s.id === text("to"));
      return stage ? `moved it to ${stage.name}` : "moved its stage";
    }
    case "owner_changed":
      return "changed the owner";
    case "value_changed":
      return "changed the value";
    case "people_set":
      return "changed the people";
    case "domain_added":
      return `added ${text("domain")}`;
    case "domain_removed":
      return `removed ${text("domain")}`;
    case "address_added":
      return `added ${text("address")}`;
    case "address_removed":
      return `removed ${text("address")}`;
    default:
      return null;
  }
}

const CONTRACT_STATUS = {
  draft: "moved back to draft",
  sent: "sent",
  signed: "signed",
  ended: "ended",
};

export function contractVerb(contract: ContractItem) {
  switch (contract.change) {
    case "created":
      return "drafted";
    case "status":
      return CONTRACT_STATUS[contract.status];
    case "document":
      return "replaced the file of";
    case "deleted":
      return "deleted";
  }
}
