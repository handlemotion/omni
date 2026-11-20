import { useLocation, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconClock,
  IconEmail,
  IconInbox,
  IconPaperPlane,
  IconTrash,
  IconWarning,
  IconWrite,
} from "@/components/icons/sidebar";
import { CrmLists, CrmNav } from "@/components/crm/crm-nav";
import { StorageNav, StoragePlaces } from "@/components/storage/storage-nav";
import { HelpdeskItems } from "./helpdesk-nav";
import { MailboxSwitcher } from "./mailbox-switcher";
import { ModuleSwitcher, useCurrentModule, WorkspaceSwitcher } from "./module-switcher";
import { CountBadge } from "./count-badge";
import { TitleBarRow, useTitleBar } from "./title-bar";
import { NotificationsButton } from "./notifications";
import { SidebarIsland } from "./sidebar-island";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
  useSidebar,
} from "@/components/ui/sidebar";
import { useCounts } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaceSlug, useWorkspaces } from "@/hooks/use-workspaces.ts";
import { workspaceHref } from "@/lib/workspaces.ts";

interface NavItem {
  label: string;
  icon: ReactNode;
  href?: string;
  current?: { path: string; lane?: string; exact?: boolean };
  unread?: boolean;
  lane?: "needs_reply" | "waiting_on_them";
}

const mail: NavItem[] = [
  {
    label: "Inbox",
    icon: <IconInbox />,
    href: "/mail/inbox",
    current: { path: "/mail/inbox" },
    unread: true,
  },
  { label: "Later", icon: <IconClock />, href: "/mail/later", current: { path: "/mail/later" } },
  {
    label: "Needs reply",
    icon: <IconBubble />,
    href: "/mail/inbox?lane=needs_reply",
    current: { path: "/mail/inbox", lane: "needs_reply" },
    lane: "needs_reply",
  },
  {
    label: "Awaiting reply",
    icon: <IconBubbleAnnotation />,
    href: "/mail/inbox?lane=waiting_on_them",
    current: { path: "/mail/inbox", lane: "waiting_on_them" },
    lane: "waiting_on_them",
  },
];

const folders: NavItem[] = [
  { label: "All mail", icon: <IconEmail />, href: "/mail/all", current: { path: "/mail/all" } },
  { label: "Drafts", icon: <IconWrite />, href: "/mail/drafts", current: { path: "/mail/drafts" } },
  { label: "Sent", icon: <IconPaperPlane />, href: "/mail/sent", current: { path: "/mail/sent" } },
  { label: "Trash", icon: <IconTrash />, href: "/mail/trash", current: { path: "/mail/trash" } },
  { label: "Spam", icon: <IconWarning />, href: "/mail/spam", current: { path: "/mail/spam" } },
];

export function AppSidebar() {
  const module = useCurrentModule();
  const titleBar = useTitleBar();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const { open, isMobile } = useSidebar();
  if (!open && !isMobile) {
    return (
      <SidebarIsland
        sections={
          module === "files"
            ? [<StoragePlaces key="places" mailbox={mailbox} />]
            : module === "crm"
              ? [<CrmLists key="lists" mailbox={mailbox} />]
              : [
                  <MailItems key="mail" mailbox={mailbox} />,
                  <Items key="folders" items={folders} mailbox={mailbox} />,
                ]
        }
      />
    );
  }
  return (
    <Sidebar closeButton={false}>
      <SidebarContent className="*:shrink-0">
        <TitleBarRow />
        {!titleBar && <WorkspaceSwitcher end={<NotificationsButton />} />}
        <div className="flex flex-col gap-3 *:shrink-0 [view-transition-name:module-nav]">
          {module === "files" ? (
            <StorageNav mailbox={mailbox} />
          ) : module === "crm" ? (
            <CrmNav mailbox={mailbox} />
          ) : (
            <MailNav mailbox={mailbox} />
          )}
        </div>
      </SidebarContent>

      <SidebarFooter className="flex-col items-stretch">
        <ModuleSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}

function MailNav({ mailbox }: { mailbox: string | undefined }) {
  return (
    <>
      <SidebarSection>
        <MailboxSwitcher />
        <MailItems mailbox={mailbox} />
      </SidebarSection>
      <Group label="Folders" items={folders} mailbox={mailbox} />
    </>
  );
}

function MailItems({ mailbox }: { mailbox: string | undefined }) {
  const shown = useShownMailbox();
  return (
    <>
      <Items items={mail} mailbox={mailbox} />
      {shown?.kind === "shared" && <HelpdeskItems mailboxId={shown.id} />}
    </>
  );
}

function useShownMailbox() {
  const { member } = useMember();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const boxes =
    useWorkspaces().data?.workspaces.find((w) => w.id === member.orgId)?.mailboxes ?? [];
  return boxes.find((box) => box.id === mailbox);
}

function withMailbox(href: string, mailbox: string | undefined) {
  if (!mailbox) return href;
  return `${href}${href.includes("?") ? "&" : "?"}mailbox=${encodeURIComponent(mailbox)}`;
}

function Group(props: { label: string; items: NavItem[]; mailbox: string | undefined }) {
  return (
    <SidebarSection label={props.label}>
      <Items items={props.items} mailbox={props.mailbox} />
    </SidebarSection>
  );
}

function Items({ items, mailbox }: { items: NavItem[]; mailbox: string | undefined }) {
  const workspace = useWorkspaceSlug();
  const { pathname } = useLocation();
  const { lane, view } = useSearch({ strict: false }) as { lane?: string; view?: string };
  const isCurrent = ({ current }: NavItem) => {
    if (!current) return false;
    const path = workspaceHref(workspace, current.path);
    return (
      !view &&
      (current.exact ? pathname === path : pathname.startsWith(path)) &&
      lane === current.lane
    );
  };

  return items.map((item) => (
    <SidebarItem
      key={item.label}
      href={item.href && workspaceHref(workspace, withMailbox(item.href, mailbox))}
      isCurrent={isCurrent(item)}
      tooltip={item.label}
    >
      {({ isCollapsed }) => (
        <>
          {item.icon}
          <SidebarLabel>{item.label}</SidebarLabel>
          {item.unread && !isCollapsed && <UnreadCount mailbox={mailbox} />}
          {item.lane && !isCollapsed && <LaneCount lane={item.lane} mailbox={mailbox} />}
        </>
      )}
    </SidebarItem>
  ));
}

function UnreadCount({ mailbox }: { mailbox: string | undefined }) {
  const counts = useCounts().data?.counts ?? [];
  const unread = counts
    .filter((c) => !mailbox || c.mailboxId === mailbox)
    .reduce((sum, c) => sum + c.unread, 0);
  if (!unread) return null;
  return <CountBadge count={unread} className="ms-auto -me-1" />;
}

function LaneCount({
  lane,
  mailbox,
}: {
  lane: NonNullable<NavItem["lane"]>;
  mailbox: string | undefined;
}) {
  const counts = useCounts().data?.counts ?? [];
  const total = counts
    .filter((c) => !mailbox || c.mailboxId === mailbox)
    .reduce((sum, c) => sum + c.lanes[lane], 0);
  if (!total) return null;
  return <span className="ms-auto text-xs text-muted-foreground tabular-nums">{total}</span>;
}
