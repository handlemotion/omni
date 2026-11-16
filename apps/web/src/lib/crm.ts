// The CRM (ADR 0036, ADR 0039 decision 1): the active company workspace's companies, people and
// deals, their timelines and contracts, and the pipeline's stages, read through `/api/crm`. Lists
// are paged by the server's cursor. Realtime keeps them current: `crm.changed` marks the whole
// CRM branch stale (`realtime.ts`), and every change here does the same when it settles.
import {
  infiniteQueryOptions,
  queryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Crm = Api["crm"];

export type CrmCompanyPage = InferResponseType<Crm["companies"]["$get"], 200>;
export type CrmCompany = CrmCompanyPage["companies"][number];
export type CrmPersonPage = InferResponseType<Crm["people"]["$get"], 200>;
export type CrmPerson = CrmPersonPage["people"][number];
export type CrmDealPage = InferResponseType<Crm["deals"]["$get"], 200>;
export type CrmDeal = CrmDealPage["deals"][number];
export type CrmCompanyDetail = InferResponseType<Crm["companies"][":id"]["$get"], 200>;
export type CrmDealDetail = InferResponseType<Crm["deals"][":id"]["$get"], 200>;
export type CrmStage = InferResponseType<Crm["stages"]["$get"], 200>["stages"][number];
export type CrmStageKind = CrmStage["kind"];
export type CrmContract = InferResponseType<Crm["contracts"]["$get"], 200>["contracts"][number];
export type CrmContractStatus = CrmContract["status"];
type TimelinePage = InferResponseType<Crm["companies"][":id"]["timeline"]["$get"], 200>;
type KnownTimelineItem = TimelinePage["items"][number];

/**
 * Mail activity a teammate's mailbox shares with the CRM (ADR 0039 decision 2): who in the
 * workspace corresponded with the record, when, and at `subjects` the subject. Typed here until
 * the layer that serves it adds it to the contracts.
 */
export interface CrmActivityItem {
  kind: "activity";
  id: string;
  at: string;
  activity: {
    mailbox: { kind: "personal" | "shared"; name: string };
    direction: "in" | "out";
    subject: string | null;
  };
}
export type CrmTimelineItem = KnownTimelineItem | CrmActivityItem;

/** The three records, as the API's paths name them. */
export type CrmRecordKind = "companies" | "people" | "deals";

const PAGE_SIZE = "50";
/** The board shows every live deal: it pages through them in large pages. */
const BOARD_PAGE_SIZE = "200";

const pageQuery = (q: string, cursor: string | null, limit = PAGE_SIZE) => ({
  ...(q ? { q } : {}),
  ...(cursor ? { cursor } : {}),
  limit,
});

/** Companies by name, `q` matching the start of the name or one of its words. */
export const crmCompaniesQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: keys.crmCompanies(q),
    queryFn: ({ pageParam, signal }) =>
      call(api.crm.companies.$get({ query: pageQuery(q, pageParam) }, { init: { signal } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** People by name; `q` also matches the start of an address. */
export const crmPeopleQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: keys.crmPeople(q),
    queryFn: ({ pageParam, signal }) =>
      call(api.crm.people.$get({ query: pageQuery(q, pageParam) }, { init: { signal } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** Deals by name. Unsearched, it is the board's list, in pages of 200. */
export const crmDealsQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: keys.crmDeals(q),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.deals.$get(
          { query: pageQuery(q, pageParam, q ? PAGE_SIZE : BOARD_PAGE_SIZE) },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const crmCompanyQuery = (id: string) =>
  queryOptions({
    queryKey: keys.crmCompany(id),
    queryFn: ({ signal }) =>
      call(api.crm.companies[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const crmPersonQuery = (id: string) =>
  queryOptions({
    queryKey: keys.crmPerson(id),
    queryFn: ({ signal }) =>
      call(api.crm.people[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const crmDealQuery = (id: string) =>
  queryOptions({
    queryKey: keys.crmDeal(id),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].$get({ param: { id } }, { init: { signal } })),
  });

/** The pipeline, in order. */
export const crmStagesQuery = () =>
  queryOptions({
    queryKey: keys.crmStages(),
    queryFn: ({ signal }) => call(api.crm.stages.$get(undefined, { init: { signal } })),
    select: (data) => data.stages.toSorted((a, b) => a.position - b.position),
  });

const timelineRoute = (kind: CrmRecordKind) =>
  kind === "companies"
    ? api.crm.companies[":id"].timeline
    : kind === "people"
      ? api.crm.people[":id"].timeline
      : api.crm.deals[":id"].timeline;

/** A record's timeline, newest first. Items of a kind this app does not know are dropped. */
export const crmTimelineQuery = (kind: CrmRecordKind, id: string) =>
  infiniteQueryOptions({
    queryKey: keys.crmTimeline(kind, id),
    queryFn: async ({ pageParam, signal }) => {
      const page = await call(
        timelineRoute(kind).$get(
          { param: { id }, query: pageParam ? { cursor: pageParam } : {} },
          { init: { signal } },
        ),
      );
      const items = (page.items as unknown[]).filter(isKnownItem);
      return { items, nextCursor: page.nextCursor };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

const KNOWN_KINDS = new Set(["event", "note", "contract", "thread", "activity"]);
function isKnownItem(item: unknown): item is CrmTimelineItem {
  const kind = (item as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && KNOWN_KINDS.has(kind);
}

/** A company's contracts (with its deals') or a deal's, newest first. */
export const crmContractsQuery = (where: { company: string } | { deal: string }) =>
  infiniteQueryOptions({
    queryKey: keys.crmContracts(where),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.contracts.$get(
          { query: { ...where, ...(pageParam ? { cursor: pageParam } : {}) } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** People, companies and deals whose name, address or domain starts with `q` (pickers). */
export const crmFindQuery = (q: string) =>
  queryOptions({
    queryKey: keys.crmFind(q),
    queryFn: ({ signal }) =>
      call(api.crm.search.$get({ query: { q, limit: "20" } }, { init: { signal } })),
    enabled: q.trim().length > 0,
  });

/** Every change can touch lists, records and timelines alike: all of the CRM refetches. */
export const crmChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: keys.crm() });

/** The deals in every cached deals list, with `change` applied to the one with `id`. */
export function patchDealInLists(
  client: QueryClient,
  id: string,
  change: (deal: CrmDeal) => CrmDeal,
) {
  client.setQueriesData<InfiniteData<CrmDealPage>>({ queryKey: keys.crmDealLists() }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            deals: page.deals.map((deal) => (deal.id === id ? change(deal) : deal)),
          })),
        }
      : data,
  );
}

/** When the record was last written to or from, once the API says (ADR 0039 decision 2). */
export function lastContactedAt(record: object): string | null {
  const value = (record as { lastContactedAt?: unknown }).lastContactedAt;
  return typeof value === "string" ? value : null;
}

/** "€12,500": minor units in their currency, whole units when there are no cents. */
export function formatMoney(minor: number | null, currency: string | null) {
  if (minor === null) return null;
  const amount = minor / 100;
  if (!currency) return new Intl.NumberFormat(undefined).format(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** "12500.50" or "12,500" typed by a person, as minor units; null when it is not a number. */
export function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
