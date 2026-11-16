// The CRM's rows in the sidebar (ADR 0039 decision 1): Companies, People and Deals. They are the
// CRM module's whole sidebar, shown alone while the CRM is open (ADR 0035). A record's page keeps
// its list's row current.
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconBuildings, IconHandshake, IconUsers } from "@/components/icons/central";
import { SidebarItem, SidebarLabel, SidebarSection } from "@/components/ui/sidebar";

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

/** A nav link that keeps showing `mailbox`, the switcher's choice, for the way back to mail. */
export function CrmNav({ mailbox }: { mailbox: string | undefined }) {
  const { pathname } = useLocation();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
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
  );
}
