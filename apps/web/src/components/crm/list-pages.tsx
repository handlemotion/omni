import { useState } from "react";
import { byAddress } from "@/components/avatar/sender-avatar";
import { useCrmCompanies, useCrmDeals, useCrmPeople } from "@/hooks/use-crm.ts";
import { useFreelancer, withoutValue } from "@/hooks/use-freelancer.ts";
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
import { BoardSort, ListFilter } from "./list-toolbar.tsx";
import { isFiltered, useListView } from "./list-view.tsx";
import { NewCompanyDialog, NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { DealIcon } from "./deal-mark.tsx";
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
const DEAL_FILTERS: FilterKind[] = ["owner", "close", "value", "archived"];
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

/** The deals, on the board by stage: the only view of them. */
export function DealsPage({ search }: { search: CrmDealsSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmDeals(dealsFilter(search), { all: true });
  const view = useListView("deals", search, list.deals);
  const [adding, setAdding] = useState(false);
  const freelancer = useFreelancer();
  const dealFilters = withoutValue(DEAL_FILTERS, (kind) => kind === "value", freelancer);
  const columns = withoutValue(DEAL_COLUMNS, (column) => column.sort === "value", freelancer);
  const sorts = withoutValue(BOARD_SORTS, (sort) => sort === "value", freelancer);
  return (
    <>
      <RecordList
        title="Deals"
        noun="deal"
        search={{ ...text, q }}
        source={sourceOf(list, list.deals)}
        columns={columns}
        filtered={isFiltered(search)}
        {...view}
        mark={(deal) => <DealIcon deal={deal} />}
        href={recordHref(inWorkspace, "deals")}
        onNew={() => setAdding(true)}
        extra={<BoardSort search={search} sorts={sorts} />}
        filter={<ListFilter search={search} filters={dealFilters} />}
        replaceBody={<DealBoard deals={list.deals} list={list} />}
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
  const freelancer = useFreelancer();
  return (
    <RecordList
      title="Projects"
      noun="project"
      search={{ ...text, q }}
      source={sourceOf(list, list.deals)}
      columns={withoutValue(DEAL_COLUMNS, (column) => column.sort === "value", freelancer)}
      filter={
        <ListFilter
          search={search}
          filters={withoutValue(PROJECT_FILTERS, (kind) => kind === "value", freelancer)}
        />
      }
      filtered={isFiltered(search)}
      {...view}
      mark={(deal) => <DealIcon deal={deal} />}
      href={recordHref(inWorkspace, "deals")}
    />
  );
}
