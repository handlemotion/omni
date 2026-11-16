// The CRM's sidebar (ADR 0039 decision 1), shown alone while the CRM is open (ADR 0035), on
// Drive's pattern: the lists (Companies, People, Deals); then the pipeline, each stage with its
// deals' count, leading to the board; then the companies as a tree whose rows open to their
// deals. A record's page keeps its list's row current. The tree and the counts read the deals the
// board loads (one cache), so the sidebar costs no request of its own beyond the first page of
// companies.
import { useLocation } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import {
  IconBuildings,
  IconCircle,
  IconCircleCheck,
  IconCircleX,
  IconHandshake,
  IconUsers,
} from "@/components/icons/central";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarItem, SidebarLabel, SidebarSection } from "@/components/ui/sidebar";
import { useCrmCompanies, useCrmDeals, useCrmStages } from "@/hooks/use-crm.ts";
import { useSidebarExpanded } from "@/hooks/use-sidebar-expanded.ts";
import type { CrmCompany, CrmDeal, CrmStageKind } from "@/lib/crm.ts";

export const CRM_LISTS = {
  companies: { label: "Companies", path: "/crm/companies" },
  people: { label: "People", path: "/crm/people" },
  deals: { label: "Deals", path: "/crm/deals" },
} as const;

const ROWS: { list: keyof typeof CRM_LISTS; icon: ReactNode }[] = [
  { list: "companies", icon: <IconBuildings className="size-icon" /> },
  { list: "people", icon: <IconUsers className="size-icon" /> },
  { list: "deals", icon: <IconHandshake className="size-icon" /> },
];

/** A stage's glyph by what it means: still open, won (or done), lost. */
const STAGE_GLYPH: Record<CrmStageKind, ReactNode> = {
  open: <IconCircle className="size-icon" />,
  won: <IconCircleCheck className="size-icon" />,
  done: <IconCircleCheck className="size-icon" />,
  lost: <IconCircleX className="size-icon" />,
};

/** Companies the tree shows; the Companies list has the rest. */
const COMPANIES_SHOWN = 12;

/** A nav link that keeps showing `mailbox`, the switcher's choice, for the way back to mail. */
export function CrmNav({ mailbox }: { mailbox: string | undefined }) {
  const { pathname } = useLocation();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  // Every deal, as the board loads them: the stage counts and the companies' deals.
  const { deals, isPending } = useCrmDeals("", { all: true });
  const byCompany = useMemo(() => {
    const map = new Map<string, CrmDeal[]>();
    for (const deal of deals) {
      if (!deal.companyId) continue;
      map.set(deal.companyId, [...(map.get(deal.companyId) ?? []), deal]);
    }
    return map;
  }, [deals]);
  return (
    <>
      <SidebarSection>
        {ROWS.map(({ list, icon }) => {
          const { label, path } = CRM_LISTS[list];
          return (
            <SidebarItem
              key={path}
              href={path + search}
              isCurrent={pathname === path || pathname.startsWith(`${path}/`)}
            >
              {icon}
              <SidebarLabel>{label}</SidebarLabel>
            </SidebarItem>
          );
        })}
      </SidebarSection>
      <Pipeline deals={deals} pending={isPending} search={search} />
      <Companies byCompany={byCompany} search={search} />
    </>
  );
}

/** The stages in order, each with how many deals sit in it; each leads to the board. */
function Pipeline(props: { deals: CrmDeal[]; pending: boolean; search: string }) {
  const stages = useCrmStages().data ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const deal of props.deals) map.set(deal.stageId, (map.get(deal.stageId) ?? 0) + 1);
    return map;
  }, [props.deals]);
  if (stages.length === 0) return null;
  return (
    <SidebarSection label="Pipeline">
      {stages.map((stage) => (
        <SidebarTreeRow
          key={stage.id}
          href={CRM_LISTS.deals.path + props.search}
          isCurrent={false}
          depth={0}
          icon={STAGE_GLYPH[stage.kind]}
          label={stage.name}
          detail={props.pending ? undefined : (counts.get(stage.id) ?? 0)}
        />
      ))}
    </SidebarSection>
  );
}

/** The first companies by name; each opens to its deals. */
function Companies(props: { byCompany: Map<string, CrmDeal[]>; search: string }) {
  const { companies, isPending } = useCrmCompanies();
  if (!isPending && companies.length === 0) return null;
  return (
    <SidebarSection label="Companies">
      {isPending ? (
        <SidebarTreeBones depth={0} />
      ) : (
        companies
          .slice(0, COMPANIES_SHOWN)
          .map((company) => (
            <Company
              key={company.id}
              company={company}
              deals={props.byCompany.get(company.id) ?? []}
              search={props.search}
            />
          ))
      )}
    </SidebarSection>
  );
}

function Company(props: { company: CrmCompany; deals: CrmDeal[]; search: string }) {
  const { company, deals } = props;
  const { pathname } = useLocation();
  const open = useSidebarExpanded("crm", company.id);
  const href = `${CRM_LISTS.companies.path}/${encodeURIComponent(company.id)}`;
  return (
    <>
      <SidebarTreeRow
        href={href + props.search}
        isCurrent={pathname === href}
        depth={0}
        icon={<IconBuildings className="size-icon" />}
        label={company.name}
        // Only a company with deals opens.
        expand={deals.length > 0 ? open : undefined}
      />
      {open.value &&
        deals.map((deal) => {
          const dealHref = `${CRM_LISTS.deals.path}/${encodeURIComponent(deal.id)}`;
          return (
            <SidebarTreeRow
              key={deal.id}
              href={dealHref + props.search}
              isCurrent={pathname === dealHref}
              depth={1}
              icon={STAGE_GLYPH[deal.stageKind]}
              label={deal.name}
            />
          );
        })}
    </>
  );
}
