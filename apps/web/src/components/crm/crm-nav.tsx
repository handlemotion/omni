import { useMemo, type ReactNode } from "react";
import {
  IconBuildings,
  IconChecklist,
  IconHandshake,
  IconProjects,
  IconUsers,
} from "@/components/icons/central";
import { RecordMark } from "./record-list.tsx";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarItem, SidebarLabel, SidebarSection } from "@/components/ui/sidebar";
import { useCrmCompanyIndex, useCrmDeals } from "@/hooks/use-crm.ts";
import type { CrmCompany, CrmDeal } from "@/lib/crm.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export const CRM_LISTS = {
  companies: { label: "Companies", path: "/crm/companies" },
  people: { label: "People", path: "/crm/people" },
  deals: { label: "Deals", path: "/crm/deals" },
  projects: { label: "Projects", path: "/crm/projects" },
  tasks: { label: "Tasks", path: "/crm/tasks" },
} as const;

const ROWS: { list: keyof typeof CRM_LISTS; icon: ReactNode }[] = [
  { list: "companies", icon: <IconBuildings className="size-icon" /> },
  { list: "people", icon: <IconUsers className="size-icon" /> },
  { list: "deals", icon: <IconHandshake className="size-icon" /> },
  { list: "projects", icon: <IconProjects className="size-icon" /> },
  { list: "tasks", icon: <IconChecklist className="size-icon" /> },
];

const WON = { kind: "won" } as const;
const LEADS = { kind: "open" } as const;

/** A nav link that keeps showing `mailbox`, the switcher's choice, for the way back to mail. */
export function CrmNav({ mailbox }: { mailbox: string | undefined }) {
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
    <>
      <SidebarSection>
        <CrmLists mailbox={mailbox} />
      </SidebarSection>
      <ActiveProjects search={search} />
    </>
  );
}

/** The lists, one row each; the closed sidebar's island shows them too. */
export function CrmLists({ mailbox }: { mailbox: string | undefined }) {
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return ROWS.map(({ list, icon }) => {
    const { label, path } = CRM_LISTS[list];
    return (
      <SidebarItem
        key={path}
        href={inWorkspace(path + search)}
        isCurrent={pathname === path || pathname.startsWith(`${path}/`)}
        tooltip={label}
      >
        {icon}
        <SidebarLabel>{label}</SidebarLabel>
      </SidebarItem>
    );
  });
}

function ActiveProjects({ search }: { search: string }) {
  const won = useCrmDeals(WON, { all: true });
  const leads = useCrmDeals(LEADS, { all: true });
  const isPending = won.isPending || leads.isPending;
  const companies = useCrmCompanyIndex();
  const projects = useMemo(
    () =>
      [...won.deals, ...leads.deals].toSorted((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    [won.deals, leads.deals],
  );
  if (!isPending && projects.length === 0) return null;
  return (
    <SidebarSection label="Projects">
      {isPending ? (
        <SidebarTreeBones depth={0} />
      ) : (
        projects.map((deal) => (
          <ProjectRow
            key={deal.id}
            deal={deal}
            client={deal.companyId ? companies.get(deal.companyId) : undefined}
            search={search}
          />
        ))
      )}
    </SidebarSection>
  );
}

function ProjectRow(props: { deal: CrmDeal; client: CrmCompany | undefined; search: string }) {
  const { client } = props;
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const href = `${CRM_LISTS.deals.path}/${encodeURIComponent(props.deal.id)}`;
  return (
    <SidebarTreeRow
      href={inWorkspace(href + props.search)}
      isCurrent={pathname === href}
      depth={0}
      icon={
        client ? (
          <span title={client.name} className="flex">
            <RecordMark
              name={client.name}
              square
              size={16}
              who={client.domain ? { domain: client.domain } : null}
            />
          </span>
        ) : props.deal.stageKind === "won" ? (
          <IconProjects className="size-icon" />
        ) : (
          <IconHandshake className="size-icon" />
        )
      }
      label={props.deal.name}
    />
  );
}
