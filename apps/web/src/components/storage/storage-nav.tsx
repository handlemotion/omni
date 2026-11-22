import { useState, type ReactNode } from "react";
import {
  IconClock3,
  IconLock,
  IconPlus,
  IconUserRound,
  IconUsers,
} from "@/components/icons/central";
import { EmptyState } from "@/components/empty/empty-state";
import { Button } from "@/components/ui/button";
import { useMember } from "@/hooks/use-session.ts";
import { IconSearch, IconTrash } from "@/components/icons/sidebar";
import { openSearch } from "@/components/search/command-menu.tsx";
import { SidebarItem, SidebarLabel, SidebarSection, useSidebar } from "@/components/ui/sidebar";
import { useHasSharedFiles, useStorageList, useTeamspaces } from "@/hooks/use-storage.ts";
import type { DriveRoot, StorageSpace } from "@/lib/storage.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { BrowseTeamspacesDialog, NewTeamspaceDialog } from "./teamspace-dialogs.tsx";
import { SidebarGroup } from "./sidebar-tree.tsx";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";

export const SPACE_LABEL = { personal: "Personal", shared: "Team" } as const;
export const SPACE_PATH = { personal: "/files/my", shared: "/files/shared" } as const;
/** Where a teamspace's top opens. */
export const TEAMSPACE_PATH = "/files/t";

/** Where a drive's top opens in the workspace. */
export const drivePath = (drive: DriveRoot) =>
  "teamspaceId" in drive
    ? `${TEAMSPACE_PATH}/${encodeURIComponent(drive.teamspaceId)}`
    : SPACE_PATH[drive.space];
export const SPACE_ICON = {
  personal: <IconUserRound className="size-icon" />,
  shared: <IconUsers className="size-icon" />,
} as const;

const TEAMSPACE_ICON = {
  open: <IconUsers className="size-icon" />,
  private: <IconLock className="size-icon" />,
} as const;

function HeldGroup(props: { space: StorageSpace; search: string }) {
  const root = useStorageList({ space: props.space });
  if (root.isPending || root.nodes.length === 0) return null;
  return (
    <SidebarGroup
      drive={{ space: props.space }}
      label={SPACE_LABEL[props.space]}
      icon={SPACE_ICON[props.space]}
      search={props.search}
    />
  );
}

function BrowseTeamspacesRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SidebarItem onPress={() => setOpen(true)} tooltip="Browse spaces">
        <IconUsers className="size-icon" />
        <SidebarLabel>Browse spaces</SidebarLabel>
      </SidebarItem>
      {open && <BrowseTeamspacesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewTeamspaceRow() {
  const [open, setOpen] = useState(false);
  const self = useMember().member.id;
  return (
    <>
      <SidebarItem onPress={() => setOpen(true)} tooltip="New space">
        <IconPlus className="size-icon" />
        <SidebarLabel>New space</SidebarLabel>
      </SidebarItem>
      {open && <NewTeamspaceDialog selfId={self} onClose={() => setOpen(false)} />}
    </>
  );
}

/** `/files` with no teamspace and nothing in My files or Shared: the way to make one. */
export function NoTeamspaces() {
  const [open, setOpen] = useState(false);
  const self = useMember().member.id;
  return (
    <StorageFrame title={<span className="text-md">Drive</span>}>
      <div className="flex flex-1 flex-col">
        <EmptyState figure="drawer" title="No spaces yet">
          <Button onPress={() => setOpen(true)}>
            <IconPlus data-slot="icon" />
            New space
          </Button>
        </EmptyState>
      </div>
      {open && <NewTeamspaceDialog selfId={self} onClose={() => setOpen(false)} />}
    </StorageFrame>
  );
}

type Row = {
  label: string;
  path: string;
  icon: ReactNode;
  company?: boolean;
  mobile?: boolean;
  action?: () => void;
};

const PLACES: Row[] = [
  {
    label: "Search",
    path: "search",
    icon: <IconSearch />,
    mobile: true,
    action: () => openSearch({ q: "", scope: "files" }),
  },
  {
    label: "Recents",
    path: "/files/recents",
    icon: <IconClock3 className="size-icon" />,
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
  const { teamspaces } = useTeamspaces();
  const search = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  return (
    <>
      <SidebarSection>
        <Rows rows={PLACES} mailbox={mailbox} />
      </SidebarSection>
      <SidebarSection label="Spaces">
        {teamspaces
          .filter((teamspace) => teamspace.role !== null)
          .map((teamspace) => (
            <SidebarGroup
              key={teamspace.id}
              drive={{ teamspaceId: teamspace.id }}
              label={teamspace.name}
              icon={teamspace.private ? TEAMSPACE_ICON.private : TEAMSPACE_ICON.open}
              search={search}
            />
          ))}
        {hasShared && <HeldGroup space="shared" search={search} />}
        <HeldGroup space="personal" search={search} />
        <NewTeamspaceRow />
        {teamspaces.some((teamspace) => teamspace.role === null) && <BrowseTeamspacesRow />}
      </SidebarSection>
    </>
  );
}

function Rows(props: { rows: Row[]; mailbox: string | undefined }) {
  const { place: pathname, href } = useWorkspacePaths();
  const hasShared = useHasSharedFiles();
  const { isMobile } = useSidebar();
  const search = props.mailbox ? `?mailbox=${encodeURIComponent(props.mailbox)}` : "";
  return props.rows
    .filter((row) => (!row.company || hasShared) && (!row.mobile || isMobile))
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
