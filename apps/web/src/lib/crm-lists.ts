import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

type Crm = Api["crm"];
type CompaniesQuery = NonNullable<InferRequestType<Crm["companies"]["$get"]>["query"]>;
type PeopleQuery = NonNullable<InferRequestType<Crm["people"]["$get"]>["query"]>;
type DealsQuery = NonNullable<InferRequestType<Crm["deals"]["$get"]>["query"]>;

/** What every list takes: a search, a sort, an owner, and the archived view. */
export interface CrmListFilter {
  q?: string;
  dir?: "asc" | "desc";
  /** A member's id, or `none`. */
  owner?: string;
  /** `only`: the archived records alone. */
  archived?: "only";
}
export interface CrmCompanyFilter extends CrmListFilter {
  sort?: NonNullable<CompaniesQuery["sort"]>;
}
export interface CrmPeopleFilter extends CrmListFilter {
  sort?: NonNullable<PeopleQuery["sort"]>;
  /** `with` a company, or `without` one. */
  company?: "with" | "without";
}
export interface CrmDealFilter extends CrmListFilter {
  sort?: NonNullable<DealsQuery["sort"]>;
  stage?: string;
  kind?: NonNullable<DealsQuery["kind"]>;
  /** `YYYY-MM-DD`, inclusive. */
  closeAfter?: string;
  closeBefore?: string;
  /** In whole units of the deal's currency, inclusive. */
  minValue?: number;
  maxValue?: number;
}

export type CrmSort = NonNullable<CrmDealFilter["sort"]>;

type ListParams = Omit<CrmListFilter, "q"> & { q?: string; sort?: CrmSort };
type DealParams = ListParams &
  Pick<CrmDealFilter, "stage" | "closeAfter" | "closeBefore" | "minValue" | "maxValue">;

/** The direction each sort starts in when the URL names a sort and no direction. */
export const SORT_START_DIR: Record<CrmSort, "asc" | "desc"> = {
  name: "asc",
  created: "desc",
  updated: "desc",
  value: "desc",
  closeOn: "asc",
  stageEntered: "desc",
};

const listParams = (search: ListParams) => ({
  q: search.q,
  dir: search.dir ?? (search.sort ? SORT_START_DIR[search.sort] : undefined),
  owner: search.owner,
  archived: search.archived,
});

/** A list page's URL search as the filter its query takes, so the loader and page agree. */
export const companiesFilter = (search: ListParams & { sort?: CrmCompanyFilter["sort"] }) =>
  ({ ...listParams(search), sort: search.sort }) satisfies CrmCompanyFilter;

export const peopleFilter = (
  search: ListParams & { sort?: CrmPeopleFilter["sort"]; company?: "with" | "without" },
) =>
  ({ ...listParams(search), sort: search.sort, company: search.company }) satisfies CrmPeopleFilter;

/** On the board, deals sort within their column by one of these. */
export const BOARD_SORTS: CrmSort[] = ["name", "value", "closeOn", "updated"];

const dealSort = (search: DealParams) =>
  search.sort && !BOARD_SORTS.includes(search.sort)
    ? { sort: undefined, dir: undefined }
    : {
        sort: search.sort,
        dir: search.dir ?? (search.sort ? SORT_START_DIR[search.sort] : undefined),
      };

/** The board keeps every filter but stage, and falls back to name order for a sort it doesn't offer. */
export const dealsFilter = (search: DealParams) =>
  ({
    ...listParams(search),
    ...dealSort(search),
    closeAfter: search.closeAfter,
    closeBefore: search.closeBefore,
    minValue: search.minValue,
    maxValue: search.maxValue,
  }) satisfies CrmDealFilter;

/** Projects are the deals in a won stage. */
export const projectsFilter = (search: DealParams) =>
  ({
    ...listParams(search),
    sort: search.sort,
    stage: search.stage,
    closeAfter: search.closeAfter,
    closeBefore: search.closeBefore,
    minValue: search.minValue,
    maxValue: search.maxValue,
    kind: "won",
  }) satisfies CrmDealFilter;

const PAGE_SIZE = 50;
const BOARD_PAGE_SIZE = 200;
const INDEX_PAGE_SIZE = 200;

/** The filter without empty values, so equal views share one cache entry. */
export function cleanFilter<T extends object>(filter: T | string | undefined) {
  const given = typeof filter === "string" ? { q: filter } : (filter ?? {});
  return Object.fromEntries(
    Object.entries(given).filter(([, value]) => value !== undefined && value !== ""),
  ) as T;
}

const shared = (filter: CrmListFilter, cursor: string | null, limit: number) => ({
  ...(filter.q ? { q: filter.q } : {}),
  ...(filter.dir ? { dir: filter.dir } : {}),
  ...(filter.owner ? { owner: filter.owner } : {}),
  ...(filter.archived ? { archived: filter.archived } : {}),
  ...(cursor ? { cursor } : {}),
  limit: String(limit),
});

const minor = (whole: number | undefined) =>
  whole === undefined ? undefined : String(Math.round(whole * 100));

function dealsQuery(filter: CrmDealFilter, cursor: string | null, limit: number) {
  const min = minor(filter.minValue);
  const max = minor(filter.maxValue);
  return {
    ...shared(filter, cursor, limit),
    ...(filter.sort ? { sort: filter.sort } : {}),
    ...(filter.stage ? { stage: filter.stage } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.closeAfter ? { closeAfter: filter.closeAfter } : {}),
    ...(filter.closeBefore ? { closeBefore: filter.closeBefore } : {}),
    ...(min ? { minValue: min } : {}),
    ...(max ? { maxValue: max } : {}),
  } satisfies DealsQuery;
}

/** Companies, by name unless `sort` says otherwise. A string is a search alone. */
export const crmCompaniesQuery = (given: CrmCompanyFilter | string = {}) => {
  const filter = cleanFilter<CrmCompanyFilter>(given);
  return infiniteQueryOptions({
    queryKey: keys.crmCompanies(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.companies.$get(
          {
            query: {
              ...shared(filter, pageParam, PAGE_SIZE),
              ...(filter.sort ? { sort: filter.sort } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
};

/** People; `q` also matches the start of an address. */
export const crmPeopleQuery = (given: CrmPeopleFilter | string = {}) => {
  const filter = cleanFilter<CrmPeopleFilter>(given);
  const hasCompany =
    filter.company === "with" ? "1" : filter.company === "without" ? "0" : undefined;
  return infiniteQueryOptions({
    queryKey: keys.crmPeople(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.people.$get(
          {
            query: {
              ...shared(filter, pageParam, PAGE_SIZE),
              ...(filter.sort ? { sort: filter.sort } : {}),
              ...(hasCompany ? { hasCompany } : {}),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
};

/** Deals. Unsearched, they come in pages of 200: the board's list. */
export const crmDealsQuery = (given: CrmDealFilter | string = {}) => {
  const filter = cleanFilter<CrmDealFilter>(given);
  const limit = filter.q ? PAGE_SIZE : BOARD_PAGE_SIZE;
  return infiniteQueryOptions({
    queryKey: keys.crmDeals(filter),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.deals.$get({ query: dealsQuery(filter, pageParam, limit) }, { init: { signal } }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
};

/** Every live company, by name, for the Company columns of people and deals. */
export const crmCompanyIndexQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.crmCompanyIndex(),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.crm.companies.$get(
          { query: shared({}, pageParam, INDEX_PAGE_SIZE) },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** The workspace's default currency, when one is set. */
export const crmSettingsQuery = () =>
  queryOptions({
    queryKey: keys.crmSettings(),
    queryFn: ({ signal }) => call(api.crm.settings.$get(undefined, { init: { signal } })),
    select: (data) => data.settings,
  });
