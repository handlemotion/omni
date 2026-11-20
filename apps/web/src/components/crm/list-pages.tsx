import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconBoard, IconList } from "@/components/icons/central";
import { byAddress } from "@/components/avatar/sender-avatar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCrmCompanies, useCrmDeals, useCrmPeople } from "@/hooks/use-crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import {
  BOARD_SORTS,
  companiesFilter,
  dealsFilter,
  peopleFilter,
  projectsFilter,
} from "@/lib/crm-lists.ts";
import type {
  CrmCompaniesSearch,
  CrmDealsSearch,
  CrmPeopleSearch,
  CrmProjectsSearch,
} from "@/lib/search-params.ts";
import { DealBoard } from "./deal-board.tsx";
import { COMPANY_COLUMNS, DEAL_COLUMNS, PEOPLE_COLUMNS } from "./list-columns.tsx";
import type { FilterKind } from "./list-filters.tsx";
import { ListFilter, ListToolbar } from "./list-toolbar.tsx";
import { isFiltered, useListView } from "./list-view.tsx";
import { NewCompanyDialog, NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { RecordList, RecordMark, useListSearch } from "./record-list.tsx";

export { StageBadge } from "./list-columns.tsx";

interface PagedQuery {
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
  hasNextPage: boolean;
  fetchNextPage: () => unknown;
  isFetchingNextPage: boolean;
}

const sourceOf = <T,>(query: PagedQuery, rows: T[]) => ({
  rows,
  isPending: query.isPending,
  isError: query.isError,
  refetch: query.refetch,
  hasNextPage: query.hasNextPage,
  fetchNextPage: query.fetchNextPage,
  isFetchingNextPage: query.isFetchingNextPage,
});

const recordHref = (inWorkspace: (path: string) => string, kind: string) => (row: { id: string }) =>
  inWorkspace(`/crm/${kind}/${encodeURIComponent(row.id)}`);

const COMPANY_FILTERS: FilterKind[] = ["owner", "archived"];
const PEOPLE_FILTERS: FilterKind[] = ["owner", "company", "archived"];
const BOARD_FILTERS: FilterKind[] = ["owner", "close", "value"];
const DEAL_FILTERS: FilterKind[] = ["owner", "stage", "close", "value", "archived"];
const PROJECT_FILTERS: FilterKind[] = ["owner", "close", "value", "archived"];

export function CompaniesPage({ search }: { search: CrmCompaniesSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmCompanies(companiesFilter(search));
  const view = useListView("companies", search, list.companies);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <RecordList
        title="Companies"
        noun="company"
        search={{ ...text, q }}
        source={sourceOf(list, list.companies)}
        columns={COMPANY_COLUMNS}
        toolbar={<ListToolbar search={search} filters={COMPANY_FILTERS} />}
        filter={<ListFilter search={search} filters={COMPANY_FILTERS} />}
        filtered={isFiltered(search)}
        {...view}
        mark={(company) => (
          <RecordMark
            name={company.name}
            square
            who={company.domain ? { domain: company.domain } : null}
          />
        )}
        href={recordHref(inWorkspace, "companies")}
        onNew={() => setAdding(true)}
      />
      {adding && <NewCompanyDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export function PeoplePage({ search }: { search: CrmPeopleSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmPeople(peopleFilter(search));
  const view = useListView("people", search, list.people);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <RecordList
        title="People"
        noun="person"
        search={{ ...text, q }}
        source={sourceOf(list, list.people)}
        columns={PEOPLE_COLUMNS}
        toolbar={<ListToolbar search={search} filters={PEOPLE_FILTERS} />}
        filter={<ListFilter search={search} filters={PEOPLE_FILTERS} />}
        filtered={isFiltered(search)}
        {...view}
        mark={(person) => (
          <RecordMark name={person.name} who={byAddress(person.addresses[0]?.address)} />
        )}
        href={recordHref(inWorkspace, "people")}
        onNew={() => setAdding(true)}
      />
      {adding && <NewPersonDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export type DealsView = "board" | "list";

/** The deals: the board by stage, or the list. A search shows the list. */
export function DealsPage({ search }: { search: CrmDealsSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const shown: DealsView = q ? "list" : (search.view ?? "board");
  const board = shown === "board";
  const list = useCrmDeals(dealsFilter(search, board), { all: board });
  const view = useListView("deals", search, list.deals);
  const [adding, setAdding] = useState(false);
  const dealSearch = board ? { ...search, archived: undefined } : search;
  const dealFilters = board ? BOARD_FILTERS : DEAL_FILTERS;
  return (
    <>
      <RecordList
        title="Deals"
        noun="deal"
        search={{ ...text, q }}
        source={sourceOf(list, list.deals)}
        columns={DEAL_COLUMNS}
        toolbar={
          <ListToolbar
            search={dealSearch}
            sorts={board ? BOARD_SORTS : undefined}
            filters={dealFilters}
          />
        }
        filtered={isFiltered(search)}
        {...view}
        mark={(deal) => <RecordMark name={deal.name} />}
        href={recordHref(inWorkspace, "deals")}
        onNew={() => setAdding(true)}
        extra={<ViewToggle view={shown} />}
        filter={<ListFilter search={dealSearch} filters={dealFilters} />}
        replaceBody={board ? <DealBoard deals={list.deals} list={list} /> : undefined}
      />
      {adding && <NewDealDialog onClose={() => setAdding(false)} />}
    </>
  );
}

/** Won deals, the work the team is delivering. */
export function ProjectsPage({ search }: { search: CrmProjectsSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmDeals(projectsFilter(search));
  const view = useListView("deals", search, list.deals);
  return (
    <RecordList
      title="Projects"
      noun="project"
      search={{ ...text, q }}
      source={sourceOf(list, list.deals)}
      columns={DEAL_COLUMNS}
      toolbar={<ListToolbar search={search} filters={PROJECT_FILTERS} />}
      filter={<ListFilter search={search} filters={PROJECT_FILTERS} />}
      filtered={isFiltered(search)}
      {...view}
      mark={(deal) => <RecordMark name={deal.name} />}
      href={recordHref(inWorkspace, "deals")}
    />
  );
}

function ViewToggle({ view }: { view: DealsView }) {
  const navigate = useNavigate();
  return (
    <ToggleGroup
      size="sq-xs"
      aria-label="Show deals as"
      selectedKeys={[view]}
      disallowEmptySelection
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next === "board" || next === "list") {
          void navigate({
            to: ".",
            search: (prev: Record<string, unknown>) => ({
              ...prev,
              view: next === "list" ? "list" : undefined,
              q: undefined,
              archived: undefined,
            }),
            replace: true,
          });
        }
      }}
    >
      <ToggleGroupItem id="board" aria-label="Board">
        <IconBoard />
      </ToggleGroupItem>
      <ToggleGroupItem id="list" aria-label="List">
        <IconList />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
