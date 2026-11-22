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
  projectsTableFilter,
} from "@/lib/crm-lists.ts";
import type {
  CrmCompaniesSearch,
  CrmPeopleSearch,
  CrmProjectsSearch,
} from "@/lib/search-params.ts";
import { DealBoard } from "./deal-board.tsx";
import {
  COMPANY_COLUMNS,
  COMPANY_NAME_WIDTH,
  DEAL_COLUMNS,
  PEOPLE_COLUMNS,
} from "./list-columns.tsx";
import type { FilterKind } from "./list-filters.tsx";
import { BoardSort, ListFilter, ProjectsView } from "./list-toolbar.tsx";
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

const dealFilters = (freelancer: boolean) =>
  withoutValue(DEAL_FILTERS, (kind) => kind === "value", freelancer);
const dealColumns = (freelancer: boolean) =>
  withoutValue(DEAL_COLUMNS, (column) => column.sort === "value", freelancer);

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
        kind="companies"
        noun="company"
        search={{ ...text, q }}
        source={sourceOf(list, list.companies)}
        columns={COMPANY_COLUMNS}
        nameClassName={COMPANY_NAME_WIDTH}
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
        kind="people"
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

/** Every deal, on the board by stage or in a table: a deal is the project from lead on. */
export function ProjectsPage({ search }: { search: CrmProjectsSearch }) {
  return search.view === "table" ? (
    <ProjectsTable search={search} />
  ) : (
    <ProjectsBoard search={search} />
  );
}

function ProjectsBoard({ search }: { search: CrmProjectsSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmDeals(dealsFilter(search), { all: true });
  const view = useListView("deals", search, list.deals);
  const [adding, setAdding] = useState(false);
  const freelancer = useFreelancer();
  const sorts = withoutValue(BOARD_SORTS, (sort) => sort === "value", freelancer);
  return (
    <>
      <RecordList
        title="Projects"
        kind="deals"
        noun="project"
        search={{ ...text, q }}
        source={sourceOf(list, list.deals)}
        columns={dealColumns(freelancer)}
        filtered={isFiltered(search)}
        {...view}
        mark={(deal) => <DealIcon deal={deal} />}
        href={recordHref(inWorkspace, "deals")}
        onNew={() => setAdding(true)}
        extra={
          <>
            <ProjectsView search={search} />
            <BoardSort search={search} sorts={sorts} />
          </>
        }
        filter={<ListFilter search={search} filters={dealFilters(freelancer)} />}
        replaceBody={<DealBoard deals={list.deals} list={list} />}
      />
      {adding && <NewDealDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function ProjectsTable({ search }: { search: CrmProjectsSearch }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const q = search.q ?? "";
  const text = useListSearch(q);
  const list = useCrmDeals(projectsTableFilter(search));
  const view = useListView("deals", search, list.deals);
  const [adding, setAdding] = useState(false);
  const freelancer = useFreelancer();
  return (
    <>
      <RecordList
        title="Projects"
        kind="deals"
        noun="project"
        search={{ ...text, q }}
        source={sourceOf(list, list.deals)}
        columns={dealColumns(freelancer)}
        filter={<ListFilter search={search} filters={dealFilters(freelancer)} />}
        filtered={isFiltered(search)}
        {...view}
        mark={(deal) => <DealIcon deal={deal} />}
        href={recordHref(inWorkspace, "deals")}
        onNew={() => setAdding(true)}
        extra={<ProjectsView search={search} />}
      />
      {adding && <NewDealDialog onClose={() => setAdding(false)} />}
    </>
  );
}
