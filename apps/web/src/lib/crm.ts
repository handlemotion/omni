import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
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
 * Mail activity a teammate's mailbox shares with the CRM: who in the
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

export {
  crmCompaniesQuery,
  crmCompanyIndexQuery,
  crmDealsQuery,
  crmPeopleQuery,
  crmSettingsQuery,
  type CrmCompanyFilter,
  type CrmDealFilter,
  type CrmListFilter,
  type CrmPeopleFilter,
  type CrmSort,
} from "./crm-lists.ts";

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

const KNOWN_KINDS = new Set(["event", "note", "contract", "thread", "activity", "meeting"]);
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
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.contracts.some((contract) => contract.signing?.status === "sent"),
      )
        ? 15_000
        : false,
  });

/** People, companies and deals whose name, address or domain starts with `q` (pickers). */
export const crmFindQuery = (q: string) =>
  queryOptions({
    queryKey: keys.crmFind(q),
    queryFn: ({ signal }) =>
      call(api.crm.search.$get({ query: { q, limit: "20" } }, { init: { signal } })),
    enabled: q.trim().length > 0,
  });

/** When the record was last written to or from, once the API says. */
export function lastContactedAt(record: object) {
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

/** The currency a new value is in: the deal's, the workspace's, then the browser's. */
export function valueCurrency(
  deal: string | null | undefined,
  workspace: string | null | undefined,
) {
  return deal || workspace || localeCurrency();
}

const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  CA: "CAD",
  AU: "AUD",
  NZ: "NZD",
  JP: "JPY",
  CN: "CNY",
  IN: "INR",
  MX: "MXN",
  BR: "BRL",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  ZA: "ZAR",
  SG: "SGD",
  HK: "HKD",
  KR: "KRW",
  AE: "AED",
};
const EURO = new Set("AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK".split(" "));

/** The browser locale's currency: its region's, else the dollar. */
export function localeCurrency() {
  const region = new Intl.Locale(navigator.language).maximize().region ?? "US";
  return EURO.has(region) ? "EUR" : (REGION_CURRENCY[region] ?? "USD");
}

/** Every currency the browser knows, by code. */
export function currencyCodes() {
  return Intl.supportedValuesOf("currency");
}

/** "12500.50" or "12,500" typed by a person, as minor units; null when it is not a number. */
export function parseMoney(text: string) {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
