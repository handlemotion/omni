import { useMemo, type ReactNode } from "react";
import {
  IconBuildings,
  IconChecklist,
  IconHandshake,
  IconProjects,
  IconUsers,
} from "@/components/icons/central";
import { useNavigate } from "@tanstack/react-router";
import { IconArrowUpRight } from "@/components/icons/central";
import { ContextMenuArea } from "@/components/ui/context-menu";
import { useCreating, type Creating } from "./create-menu.tsx";
import { RecordMark } from "./record-list.tsx";
import { useRecordMenu } from "./record-menu.tsx";
import { SidebarTreeBones, SidebarTreeRow } from "@/components/shell/sidebar-tree-row";
import { SidebarItem, SidebarLabel, SidebarSection } from "@/components/ui/sidebar";
import { useCrmCompanyIndex, useCrmDeals } from "@/hooks/use-crm.ts";
import type { CrmCompany, CrmDeal } from "@/lib/crm.ts";
import { PROJECT_KINDS } from "@/lib/crm-lists.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export const CRM_LISTS = {
  companies: { label: "Companies", path: "/crm/companies" },
  people: { label: "People", path: "/crm/people" },
  deals: { label: "Deals", path: "/crm/deals" },
  projects: { label: "Projects", path: "/crm/projects" },
  tasks: { label: "Tasks", path: "/crm/tasks" },
} as const;

const ROWS: { list: keyof typeof CRM_LISTS; icon: ReactNode; creates: Creating }[] = [
  { list: "companies", icon: <IconBuildings className="size-icon" />, creates: "company" },
  { list: "people", icon: <IconUsers className="size-icon" />, creates: "person" },
  { list: "deals", icon: <IconHandshake className="size-icon" />, creates: "deal" },
  { list: "projects", icon: <IconProjects className="size-icon" />, creates: "deal" },
  { list: "tasks", icon: <IconChecklist className="size-icon" />, creates: "task" },
];

const PROJECTS = { kind: PROJECT_KINDS };

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

function CrmLists({ mailbox }: { mailbox: string | undefined }) {
  const { place: pathname, href: inWorkspace } = useWorkspacePaths();
  const navigate = useNavigate();
  const creating = useCreating();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
    <>
      {ROWS.map(({ list, icon, creates }) => {
        const { label, path } = CRM_LISTS[list];
        const href = inWorkspace(path + search);
        return (
          <ContextMenuArea
            key={path}
            label={label}
            menu={() => [
              { icon: IconArrowUpRight, label: "Open", onAction: () => void navigate({ href }) },
              "separator",
              ...creating.entries([creates]),
            ]}
          >
            <SidebarItem
              href={href}
              isCurrent={pathname === path || pathname.startsWith(`${path}/`)}
              tooltip={label}
            >
              {icon}
              <SidebarLabel>{label}</SidebarLabel>
            </SidebarItem>
          </ContextMenuArea>
        );
      })}
      {creating.dialogs}
    </>
  );
}

function ActiveProjects({ search }: { search: string }) {
  const { deals, isPending } = useCrmDeals(PROJECTS, { all: true });
  const companies = useCrmCompanyIndex();
  const menu = useRecordMenu("deals");
  const projects = useMemo(
    () =>
      deals.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [deals],
  );
  if (!isPending && projects.length === 0) return null;
  return (
    <SidebarSection label="Projects">
      {isPending ? (
        <SidebarTreeBones depth={0} />
      ) : (
        projects.map((deal) => (
          <ContextMenuArea key={deal.id} label={deal.name} menu={() => menu.entries(deal)}>
            <ProjectRow
              deal={deal}
              client={deal.companyId ? companies.get(deal.companyId) : undefined}
              search={search}
            />
          </ContextMenuArea>
        ))
      )}
      {menu.dialogs}
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
        client || props.deal.iconUrl ? (
          <span title={client?.name} className="flex">
            <RecordMark
              name={client?.name ?? props.deal.name}
              square
              size={16}
              src={props.deal.iconUrl}
              who={client?.domain ? { domain: client.domain } : null}
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
