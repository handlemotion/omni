import type { ReactNode } from "react";
import { IconFolderShared, IconUpload, IconUserRound, IconUsers } from "@/components/icons/central";
import { IconSearch, IconTrash } from "@/components/icons/sidebar";
import { openSearch } from "@/components/search/command-menu.tsx";
import { FileTrigger } from "@/components/ui/file-trigger";
import {
  SidebarItem,
  SidebarItemTrigger,
  SidebarLabel,
  SidebarSection,
} from "@/components/ui/sidebar";
import { useHasSharedFiles, useUploads } from "@/hooks/use-storage.ts";
import type { StoragePlace } from "@/lib/storage.ts";
import { SidebarGroup } from "./sidebar-tree.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export const SPACE_LABEL = { personal: "Personal", shared: "Team" } as const;
export const SPACE_PATH = { personal: "/files/my", shared: "/files/shared" } as const;
export const SPACE_ICON = {
  personal: <IconUserRound className="size-icon" />,
  shared: <IconUsers className="size-icon" />,
} as const;

type Row = { label: string; path: string; icon: ReactNode; company?: boolean; action?: () => void };

const PLACES: Row[] = [
  {
    label: "Search",
    path: "search",
    icon: <IconSearch />,
    action: () => openSearch({ q: "", scope: "files" }),
  },
  {
    label: "Shared with me",
    path: "/files/shared-with-me",
    icon: <IconFolderShared className="size-icon" />,
  },
  {
    label: "Trash",
    path: "/files/trash",
    icon: <IconTrash />,
  },
];

/** A nav link that keeps showing `mailbox`, the switcher's choice, for the way back to mail. */
export function StorageNav({ mailbox }: { mailbox: string | undefined }) {
  const hasShared = useHasSharedFiles();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
    <>
      <SidebarSection>
        <UploadRow />
        <Rows rows={PLACES} mailbox={mailbox} />
      </SidebarSection>
      <SidebarSection label="Folders">
        {hasShared && <SidebarGroup space="shared" search={search} />}
        <SidebarGroup space="personal" search={search} />
      </SidebarSection>
    </>
  );
}

function Rows(props: { rows: Row[]; mailbox: string | undefined }) {
  const { place: pathname, href } = useWorkspacePaths();
  const hasShared = useHasSharedFiles();
  const search = props.mailbox ? `?mailbox=${encodeURIComponent(props.mailbox)}` : "";
  return props.rows
    .filter((row) => !row.company || hasShared)
    .map((row) => (
      <SidebarItem
        key={row.path}
        {...(row.action
          ? { onPress: row.action }
          : {
              href: href(row.path + search),
              isCurrent: pathname === row.path || pathname.startsWith(`${row.path}/`),
            })}
        tooltip={row.label}
      >
        {row.icon}
        <SidebarLabel>{row.label}</SidebarLabel>
      </SidebarItem>
    ));
}

function UploadRow() {
  const { upload } = useUploads();
  const place = useUploadPlace();
  return (
    <FileTrigger
      allowsMultiple
      onSelect={(files) => {
        const picked = [...(files ?? [])];
        if (!picked.length) return;
        upload(picked, { place }, (name, error) =>
          storageErrorToast(error, `“${name}” was not uploaded`),
        );
      }}
    >
      <SidebarItemTrigger>
        <IconUpload />
        <SidebarLabel>Upload</SidebarLabel>
      </SidebarItemTrigger>
    </FileTrigger>
  );
}

const useUploadPlace: () => StoragePlace = () => {
  const { place: pathname } = useWorkspacePaths();
  for (const space of ["personal", "shared"] as const) {
    const root = SPACE_PATH[space];
    if (pathname === root) return { space };
    if (pathname.startsWith(`${root}/`)) {
      return { parentId: decodeURIComponent(pathname.slice(root.length + 1)) };
    }
  }
  return { space: "personal" };
};
