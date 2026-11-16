// Storage's rows in the sidebar (ADR 0034 decision 8): My files, Shared (a company's only: a
// Personal space has no Shared), Shared with me and Trash. They are the Files module's whole
// sidebar, shown alone while Files is open (ADR 0035).
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconFolder, IconFolderShared, IconUsers } from "@/components/icons/central";
import { IconTrash } from "@/components/icons/sidebar";
import { SidebarItem, SidebarLabel, SidebarSection } from "@/components/ui/sidebar";
import { useHasSharedFiles } from "@/hooks/use-storage.ts";

export const SPACE_LABEL = { personal: "My files", shared: "Shared" } as const;
export const SPACE_PATH = { personal: "/files/my", shared: "/files/shared" } as const;

const ROWS: { label: string; path: string; icon: ReactNode; company?: boolean }[] = [
  {
    label: SPACE_LABEL.personal,
    path: SPACE_PATH.personal,
    icon: <IconFolder className="size-icon" />,
  },
  {
    label: SPACE_LABEL.shared,
    path: SPACE_PATH.shared,
    icon: <IconFolderShared className="size-icon" />,
    company: true,
  },
  {
    label: "Shared with me",
    path: "/files/shared-with-me",
    icon: <IconUsers className="size-icon" />,
  },
  { label: "Trash", path: "/files/trash", icon: <IconTrash /> },
];

/** A nav link that keeps showing `mailbox`, the switcher's choice, for the way back to mail. */
export function StorageNav({ mailbox }: { mailbox: string | undefined }) {
  const { pathname } = useLocation();
  const hasShared = useHasSharedFiles();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
    <SidebarSection>
      {ROWS.filter((row) => !row.company || hasShared).map((row) => (
        <SidebarItem
          key={row.path}
          href={row.path + search}
          // A folder's page is under its space's path, so the space stays current inside it.
          isCurrent={pathname === row.path || pathname.startsWith(`${row.path}/`)}
        >
          {row.icon}
          <SidebarLabel>{row.label}</SidebarLabel>
        </SidebarItem>
      ))}
    </SidebarSection>
  );
}
