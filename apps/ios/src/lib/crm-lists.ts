import type { SymbolName } from "./symbols.ts";

/** The CRM's lists, as its web sidebar names them. Projects are deals in a `won` stage. */
export const CRM_PAGES = {
  companies: { label: "Companies", icon: "building.2", empty: "No companies yet" },
  people: { label: "People", icon: "person.2", empty: "No people yet" },
  deals: { label: "Deals", icon: "briefcase", empty: "No deals yet" },
  projects: { label: "Projects", icon: "checkmark.seal", empty: "No projects yet" },
} as const satisfies Record<string, { label: string; icon: SymbolName; empty: string }>;

export type CrmPage = keyof typeof CRM_PAGES;

export const isCrmPage = (page: string | undefined): page is CrmPage =>
  !!page && Object.hasOwn(CRM_PAGES, page);

/** What a list can be ordered by; deals and projects also by value and close date. */
export type ListSort = "name" | "created" | "updated" | "value" | "closeOn";
export type ListDir = "asc" | "desc";

/**
 * How one list is shown: its order, its filters (an owner's member id or `none`, people without
 * a company, a deal's stage) and whether it shows the archived records instead of the live ones.
 */
export interface ListView {
  sort: ListSort;
  dir: ListDir;
  owner: string | null;
  noCompany: boolean;
  stage: string | null;
  archived: boolean;
}

export const DEFAULT_VIEW: ListView = {
  sort: "name",
  dir: "asc",
  owner: null,
  noCompany: false,
  stage: null,
  archived: false,
};

const RECORD_SORTS = [
  { id: "name", label: "Name" },
  { id: "created", label: "Created" },
  { id: "updated", label: "Updated" },
] as const satisfies { id: ListSort; label: string }[];

const DEAL_SORTS = [
  ...RECORD_SORTS,
  { id: "value", label: "Value" },
  { id: "closeOn", label: "Close date" },
] as const satisfies { id: ListSort; label: string }[];

/** The orders a page offers, in the order its menu lists them. */
export const sortsFor = (page: CrmPage) => (isDealPage(page) ? DEAL_SORTS : RECORD_SORTS);

export const sortLabel = (sort: ListSort) =>
  DEAL_SORTS.find((one) => one.id === sort)?.label ?? "Name";

/** Deals and Projects list the same records. */
export const isDealPage = (page: CrmPage) => page === "deals" || page === "projects";

/** The API path a page lists. */
export const recordsOf = (page: CrmPage) => (isDealPage(page) ? "deals" : page);

/** How many filters a view narrows by, for its chip. */
export const filterCount = (view: ListView) =>
  [view.owner, view.noCompany || null, view.stage, view.archived || null].filter(Boolean).length;

const shared = (view: ListView) => ({
  sort: view.sort === "value" || view.sort === "closeOn" ? "name" : view.sort,
  dir: view.dir,
  ...(view.owner ? { owner: view.owner } : {}),
  ...(view.archived ? { archived: "only" as const } : {}),
});

/** A companies list's query string. */
export const companiesQuery = (view: ListView) => shared(view);

/** A people list's query string. */
export const peopleQuery = (view: ListView) => ({
  ...shared(view),
  ...(view.noCompany ? { hasCompany: "0" as const } : {}),
});

/** A deals list's query string; Projects add `kind=won`, the board drops the stage filter. */
export const dealsQuery = (view: ListView, projects: boolean) => ({
  ...shared(view),
  sort: view.sort,
  ...(view.stage ? { stage: view.stage } : {}),
  ...(projects ? { kind: "won" as const } : {}),
});
