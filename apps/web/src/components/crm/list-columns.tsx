import { Badge } from "@/components/ui/badge";
import { useCrmCompanyIndex, useCrmStages, useOwners } from "@/hooks/use-crm.ts";
import {
  formatMoney,
  lastContactedAt,
  type CrmCompany,
  type CrmDeal,
  type CrmPerson,
  type CrmStage,
} from "@/lib/crm.ts";
import { MemberAvatar } from "./member-avatar.tsx";
import { DAY, Muted, RecordMark, type RecordColumn } from "./record-list.tsx";

const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null);
/** A `YYYY-MM-DD` date, read in the viewer's own day. */
export const calendarDay = (iso: string | null | undefined) =>
  iso ? DAY.format(new Date(`${iso}T00:00:00`)) : null;

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

function OwnerCell({ id }: { id: string | null | undefined }) {
  const owner = useOwners().find((o) => o.id === id);
  if (!owner) return <Muted>{null}</Muted>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MemberAvatar name={owner.name} image={owner.image} size={18} />
      <Muted>{owner.name}</Muted>
    </span>
  );
}

function CompanyCell({ id }: { id: string | null }) {
  const company = useCrmCompanyIndex().get(id ?? "");
  if (!company) return <Muted>{null}</Muted>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <RecordMark
        name={company.name}
        square
        size={18}
        who={company.domain ? { domain: company.domain } : null}
      />
      <Muted>{company.name}</Muted>
    </span>
  );
}

function StageCell({ deal }: { deal: CrmDeal }) {
  const stages = useCrmStages().data ?? [];
  return <StageBadge stage={stages.find((s) => s.id === deal.stageId)} deal={deal} />;
}

function lastContacted<T extends object>(className: string) {
  const column: RecordColumn<T> = {
    title: "Last contacted",
    className,
    cell: (row) => <Muted>{day(lastContactedAt(row))}</Muted>,
  };
  return column;
}

function owner<T extends { ownerMemberId?: string | null }>(className: string) {
  const column: RecordColumn<T> = {
    title: "Owner",
    className,
    cell: (row) => <OwnerCell id={row.ownerMemberId} />,
  };
  return column;
}

function added<T extends { createdAt: string }>(className: string) {
  const column: RecordColumn<T> = {
    title: "Added",
    className,
    sort: "created",
    cell: (row) => <Muted>{day(row.createdAt)}</Muted>,
  };
  return column;
}

export const COMPANY_COLUMNS: RecordColumn<CrmCompany>[] = [
  {
    title: "Description",
    className: "w-[32%] max-sm:hidden",
    cell: (company) => <Muted>{company.description}</Muted>,
  },
  owner("w-40 max-md:hidden"),
  lastContacted("w-36 max-lg:hidden"),
  added("w-32"),
];

export const PEOPLE_COLUMNS: RecordColumn<CrmPerson>[] = [
  {
    title: "Email",
    className: "w-[24%] max-sm:hidden",
    cell: (person) => <Muted>{person.addresses[0]?.address}</Muted>,
  },
  {
    title: "Company",
    className: "w-44 max-md:hidden",
    cell: (person) => <CompanyCell id={person.companyId} />,
  },
  {
    title: "Title",
    className: "w-40 max-xl:hidden",
    cell: (person) => <Muted>{person.jobTitle}</Muted>,
  },
  owner("w-40 max-lg:hidden"),
  lastContacted("w-36 max-xl:hidden"),
  added("w-32"),
];

export const DEAL_COLUMNS: RecordColumn<CrmDeal>[] = [
  { title: "Stage", className: "w-36", cell: (deal) => <StageCell deal={deal} /> },
  {
    title: "Value",
    className: "w-32 max-sm:hidden",
    sort: "value",
    cell: (deal) => <Muted>{formatMoney(deal.valueMinor, deal.valueCurrency)}</Muted>,
  },
  {
    title: "Company",
    className: "w-44 max-md:hidden",
    cell: (deal) => <CompanyCell id={deal.companyId} />,
  },
  {
    title: "Close date",
    className: "w-32 max-lg:hidden",
    sort: "closeOn",
    cell: (deal) => <Muted>{calendarDay(deal.expectedCloseOn)}</Muted>,
  },
  owner("w-40 max-lg:hidden"),
  added("w-32 max-xl:hidden"),
];
