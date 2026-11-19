import type { Api } from "@omni/client";
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { SymbolName } from "./symbols.ts";

const PAGE_SIZE = "100";

type Crm = Api["crm"];
export type CrmCompany = InferResponseType<Crm["companies"]["$get"], 200>["companies"][number];
export type CrmPerson = InferResponseType<Crm["people"]["$get"], 200>["people"][number];
export type CrmDeal = InferResponseType<Crm["deals"]["$get"], 200>["deals"][number];

/** The CRM's lists, as its web sidebar names them. */
export const CRM_PAGES = {
  companies: { label: "Companies", icon: "building.2", empty: "No companies yet" },
  people: { label: "People", icon: "person.2", empty: "No people yet" },
  deals: { label: "Deals", icon: "briefcase", empty: "No deals yet" },
} as const satisfies Record<string, { label: string; icon: SymbolName; empty: string }>;

export type CrmPage = keyof typeof CRM_PAGES;

export const isCrmPage = (page: string | undefined): page is CrmPage =>
  !!page && Object.hasOwn(CRM_PAGES, page);

const paged = (pageParam: string | null) => ({
  limit: PAGE_SIZE,
  ...(pageParam ? { cursor: pageParam } : {}),
});

export const useCompanies = () =>
  useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("companies"),
      queryFn: ({ pageParam, signal }) =>
        call(api.crm.companies.$get({ query: paged(pageParam) }, { init: { signal } })),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.companies),
    }),
  );

export const usePeople = () =>
  useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("people"),
      queryFn: ({ pageParam, signal }) =>
        call(api.crm.people.$get({ query: paged(pageParam) }, { init: { signal } })),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.people),
    }),
  );

export const useDeals = () =>
  useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("deals"),
      queryFn: ({ pageParam, signal }) =>
        call(api.crm.deals.$get({ query: paged(pageParam) }, { init: { signal } })),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.deals),
    }),
  );

export const useCompany = (id: string) =>
  useQuery({
    queryKey: keys.crmRecord("company", id),
    queryFn: ({ signal }) =>
      call(api.crm.companies[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const usePerson = (id: string) =>
  useQuery({
    queryKey: keys.crmRecord("person", id),
    queryFn: ({ signal }) =>
      call(api.crm.people[":id"].$get({ param: { id } }, { init: { signal } })),
  });

export const useDeal = (id: string) =>
  useQuery({
    queryKey: keys.crmRecord("deal", id),
    queryFn: ({ signal }) =>
      call(api.crm.deals[":id"].$get({ param: { id } }, { init: { signal } })),
  });

/** The pipeline's stages, for a deal's stage name. */
export const stagesQuery = () =>
  queryOptions({
    queryKey: keys.crmStages(),
    queryFn: ({ signal }) => call(api.crm.stages.$get({}, { init: { signal } })),
    select: (data) => new Map(data.stages.map((stage) => [stage.id, stage.name])),
    staleTime: 5 * 60_000,
  });

export const useStageNames = () => useQuery(stagesQuery());

/**
 * A deal's value as the web shows it (`formatMoney`): `valueMinor` is hundredths of the currency
 * for every currency, whole units when there are no cents; null when it has none.
 */
export function dealValue(deal: Pick<CrmDeal, "valueMinor" | "valueCurrency">) {
  if (deal.valueMinor === null) return null;
  const amount = deal.valueMinor / 100;
  const currency = deal.valueCurrency;
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

/** CRM search: the people, companies and deals a query names. */
export const useCrmSearch = (q: string) =>
  useQuery({
    queryKey: keys.crmSearch(q),
    queryFn: ({ signal }) =>
      call(api.crm.search.$get({ query: { q, limit: "20" } }, { init: { signal } })),
    enabled: q.trim().length > 0,
    placeholderData: (previous) => previous,
  });
