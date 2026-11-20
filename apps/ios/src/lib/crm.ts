import type { Api } from "@omni/client";
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect } from "react";
import { api, call } from "./api.ts";
import {
  DEFAULT_VIEW,
  companiesQuery,
  dealsQuery,
  peopleQuery,
  type ListView,
} from "./crm-lists.ts";
import { keys } from "./query-keys.ts";

export { CRM_PAGES, isCrmPage, type CrmPage } from "./crm-lists.ts";

const PAGE_SIZE = "100";
const BOARD_PAGE_SIZE = "200";

type Crm = Api["crm"];
export type CrmCompany = InferResponseType<Crm["companies"]["$get"], 200>["companies"][number];
export type CrmPerson = InferResponseType<Crm["people"]["$get"], 200>["people"][number];
export type CrmDeal = InferResponseType<Crm["deals"]["$get"], 200>["deals"][number];

const paged = (pageParam: string | null, size = PAGE_SIZE) => ({
  limit: size,
  ...(pageParam ? { cursor: pageParam } : {}),
});

/** The live companies, or the archived ones, in the view's order and filters. */
export function useCompanies(view: ListView = DEFAULT_VIEW) {
  const query = companiesQuery(view);
  return useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("companies", query),
      queryFn: ({ pageParam, signal }) =>
        call(
          api.crm.companies.$get(
            { query: { ...query, ...paged(pageParam) } },
            { init: { signal } },
          ),
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.companies),
    }),
  );
}

/** The live people, or the archived ones, in the view's order and filters. */
export function usePeople(view: ListView = DEFAULT_VIEW) {
  const query = peopleQuery(view);
  return useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("people", query),
      queryFn: ({ pageParam, signal }) =>
        call(
          api.crm.people.$get({ query: { ...query, ...paged(pageParam) } }, { init: { signal } }),
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.people),
    }),
  );
}

/**
 * Deals in the view's order and filters; `projects` lists the won ones only,
 * `leads` the open ones. `whole` asks in the
 * largest pages, for a board that loads every deal to count each stage.
 */
export function useDeals(
  view: ListView = DEFAULT_VIEW,
  options: { projects?: boolean; leads?: boolean; whole?: boolean } = {},
) {
  const query = dealsQuery(view, options.projects ? "won" : options.leads ? "open" : undefined);
  const size = options.whole ? BOARD_PAGE_SIZE : PAGE_SIZE;
  return useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: keys.crmList("deals", { ...query, limit: size }),
      queryFn: ({ pageParam, signal }) =>
        call(
          api.crm.deals.$get(
            { query: { ...query, ...paged(pageParam, size) } },
            { init: { signal } },
          ),
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      select: (data) => data.pages.flatMap((one) => one.deals),
    }),
  );
}

export const useCompany = (id: string) =>
  useQuery({
    queryKey: keys.crmRecord("company", id),
    queryFn: ({ signal }) =>
      call(api.crm.companies[":id"].$get({ param: { id } }, { init: { signal } })),
  });

function useDrained<
  T extends { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown },
>(query: T) {
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return query;
}

/**
 * The active projects (deals in a `won` stage) and leads (in an `open` one), by name, each with
 * its client from the company
 * list (its name and a domain for the logo).
 */
export function useActiveProjects() {
  const won = useDrained(useDeals(DEFAULT_VIEW, { projects: true, whole: true })).data ?? [];
  const leads = useDrained(useDeals(DEFAULT_VIEW, { leads: true, whole: true })).data ?? [];
  const companies = useDrained(useCompanies()).data ?? [];
  const clients = new Map(companies.map((company) => [company.id, company]));
  return [...won, ...leads]
    .map((deal) => ({ deal, client: deal.companyId ? clients.get(deal.companyId) : undefined }))
    .toSorted((a, b) => a.deal.name.localeCompare(b.deal.name, undefined, { sensitivity: "base" }));
}

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

/** The workspace's CRM settings: its default currency. */
export const useCrmSettings = () =>
  useQuery({
    queryKey: keys.crmSettings(),
    queryFn: ({ signal }) => call(api.crm.settings.$get({}, { init: { signal } })),
    select: (data) => data.settings,
    staleTime: 5 * 60_000,
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

/** A `YYYY-MM-DD` day as the device writes a date ("Dec 3, 2026"). */
export function dayText(day: string | null | undefined) {
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { dateStyle: "medium" });
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
