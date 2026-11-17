import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { IconBoard, IconList } from "@/components/icons/central";
import { byAddress } from "@/components/avatar/sender-avatar";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCrmCompanies, useCrmDeals, useCrmPeople, useCrmStages } from "@/hooks/use-crm.ts";
import {
  formatMoney,
  lastContactedAt,
  type CrmCompany,
  type CrmDeal,
  type CrmPerson,
  type CrmStage,
} from "@/lib/crm.ts";
import { DealBoard } from "./deal-board.tsx";
import { NewCompanyDialog, NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import {
  DAY,
  Muted,
  RecordList,
  RecordMark,
  useListSearch,
  type RecordColumn,
} from "./record-list.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null);

const lastContactedColumn = {
  title: "Last contacted",
  className: "w-36 max-md:hidden",
  cell: (row: object) => <Muted>{day(lastContactedAt(row))}</Muted>,
};

const COMPANY_COLUMNS: RecordColumn<CrmCompany>[] = [
  {
    title: "Description",
    className: "w-[40%] max-sm:hidden",
    cell: (company) => <Muted>{company.description}</Muted>,
  },
  lastContactedColumn,
  { title: "Added", className: "w-32", cell: (company) => <Muted>{day(company.createdAt)}</Muted> },
];

const PEOPLE_COLUMNS: RecordColumn<CrmPerson>[] = [
  {
    title: "Email",
    className: "w-[30%] max-sm:hidden",
    cell: (person) => <Muted>{person.addresses[0]?.address}</Muted>,
  },
  {
    title: "Title",
    className: "w-44 max-md:hidden",
    cell: (person) => <Muted>{person.jobTitle}</Muted>,
  },
  lastContactedColumn,
  { title: "Added", className: "w-32", cell: (person) => <Muted>{day(person.createdAt)}</Muted> },
];

const dealColumns = (stages: CrmStage[]) => {
  const result: RecordColumn<CrmDeal>[] = [
    {
      title: "Stage",
      className: "w-40",
      cell: (deal) => <StageBadge stage={stages.find((s) => s.id === deal.stageId)} deal={deal} />,
    },
    {
      title: "Value",
      className: "w-36 max-sm:hidden",
      cell: (deal) => <Muted>{formatMoney(deal.valueMinor, deal.valueCurrency)}</Muted>,
    },
    {
      title: "Added",
      className: "w-32 max-md:hidden",
      cell: (deal) => <Muted>{day(deal.createdAt)}</Muted>,
    },
  ];
  return result;
};

/** A stage's name, coloured by its kind: open neutral, won and done green, lost red. */
export function StageBadge({ stage, deal }: { stage: CrmStage | undefined; deal: CrmDeal }) {
  const kind = stage?.kind ?? deal.stageKind;
  const intent = kind === "lost" ? "danger" : kind === "open" ? "secondary" : "success";
  return (
    <Badge intent={intent} className="max-w-full truncate">
      {stage?.name ?? kind}
    </Badge>
  );
}

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

export function CompaniesPage({ q }: { q: string }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const search = useListSearch(q);
  const list = useCrmCompanies(q);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <RecordList
        title="Companies"
        noun="company"
        search={{ ...search, q }}
        source={sourceOf(list, list.companies)}
        columns={COMPANY_COLUMNS}
        mark={(company) => (
          <RecordMark
            name={company.name}
            square
            who={company.domain ? { domain: company.domain } : null}
          />
        )}
        href={(company) => inWorkspace(`/crm/companies/${encodeURIComponent(company.id)}`)}
        onNew={() => setAdding(true)}
      />
      {adding && <NewCompanyDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export function PeoplePage({ q }: { q: string }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const search = useListSearch(q);
  const list = useCrmPeople(q);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <RecordList
        title="People"
        noun="person"
        search={{ ...search, q }}
        source={sourceOf(list, list.people)}
        columns={PEOPLE_COLUMNS}
        mark={(person) => (
          <RecordMark name={person.name} who={byAddress(person.addresses[0]?.address)} />
        )}
        href={(person) => inWorkspace(`/crm/people/${encodeURIComponent(person.id)}`)}
        onNew={() => setAdding(true)}
      />
      {adding && <NewPersonDialog onClose={() => setAdding(false)} />}
    </>
  );
}

export type DealsView = "board" | "list";

/** The deals: the board by stage, or the list. A search shows the list. */
export function DealsPage({ q, view }: { q: string; view: DealsView }) {
  const { href: inWorkspace } = useWorkspacePaths();
  const search = useListSearch(q);
  const shown: DealsView = q ? "list" : view;
  const list = useCrmDeals(q, { all: shown === "board" });
  const stages = useCrmStages().data ?? [];
  const [adding, setAdding] = useState(false);
  return (
    <>
      <RecordList
        title="Deals"
        noun="deal"
        search={{ ...search, q }}
        source={sourceOf(list, list.deals)}
        columns={dealColumns(stages)}
        mark={(deal) => <RecordMark name={deal.name} />}
        href={(deal) => inWorkspace(`/crm/deals/${encodeURIComponent(deal.id)}`)}
        onNew={() => setAdding(true)}
        extra={<ViewToggle view={shown} />}
        replaceBody={shown === "board" ? <DealBoard deals={list.deals} list={list} /> : undefined}
      />
      {adding && <NewDealDialog onClose={() => setAdding(false)} />}
    </>
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
