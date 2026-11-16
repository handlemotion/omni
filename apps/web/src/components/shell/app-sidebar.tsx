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
import { Badge } from "@/components/ui/badge";
import { SearchPopover } from "@/components/search/search-popover";
import { CrmNav } from "@/components/crm/crm-nav";
import { StorageNav } from "@/components/storage/storage-nav";
import { HelpdeskItems } from "./helpdesk-nav";
import { MailboxSwitcher } from "./mailbox-switcher";
import { ModuleSwitcher, useCurrentModule, WorkspaceSwitcher } from "./module-switcher";
import { CountBadge } from "./count-badge";
import { NotificationsButton } from "./notifications";
import {
  Sidebar,
  SidebarContent,
  SidebarDisclosure,
  SidebarDisclosurePanel,
  SidebarDisclosureTrigger,
  SidebarFooter,
  SidebarItem,
  SidebarItemTrigger,
  SidebarLabel,
  SidebarSection,
  useSidebar,
} from "@/components/ui/sidebar";
import { useOpenCompose } from "@/hooks/use-compose-pane.ts";
import { useConnectivity } from "@/hooks/use-connectivity.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { useCounts } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";

/** A nav row. No `href`: the frame shows it, but the app has no view for it yet. */
interface NavItem {
  label: string;
  icon: ReactNode;
  href?: string;
  /** Path (and lane, for inbox lanes) that marks this row current. */
  current?: { path: string; lane?: string; exact?: boolean };
  /** Shows the inbox's unread threads at the row's end. */
  unread?: boolean;
}

const mail: NavItem[] = [
  {
    label: "Inbox",
    icon: <IconInbox />,
    href: "/inbox",
    current: { path: "/inbox" },
    unread: true,
  },
  { label: "Later", icon: <IconClock />, href: "/later", current: { path: "/later" } },
  {
    label: "Needs reply",
    icon: <IconBubble />,
    href: "/inbox?lane=needs_reply",
    current: { path: "/inbox", lane: "needs_reply" },
  },
  {
    label: "Awaiting reply",
    icon: <IconBubbleAnnotation />,
    href: "/inbox?lane=waiting_on_them",
    current: { path: "/inbox", lane: "waiting_on_them" },
  },
];

const folders: NavItem[] = [
  { label: "All mail", icon: <IconEmail />, href: "/all", current: { path: "/all" } },
  { label: "Drafts", icon: <IconWrite />, href: "/drafts", current: { path: "/drafts" } },
  { label: "Sent", icon: <IconPaperPlane />, href: "/sent", current: { path: "/sent" } },
  { label: "Trash", icon: <IconTrash />, href: "/trash", current: { path: "/trash" } },
  { label: "Spam", icon: <IconWarning />, href: "/spam", current: { path: "/spam" } },
];

// Figma: Omni, sidebar (node 1:3). One module at a time (ADR 0035), after Skiff: the top row is
// the module, and its menu switches module and workspace; the rest is that module's own. The
// sidebar's toggle closes it from the footer; closed, the toggle starts each page's header
// (`PageNav`).
export function AppSidebar() {
  const module = useCurrentModule();
  // The links carry the URL's mailbox as it is, not the one found in the workspace list: right
  // after a switch that list is still loading, and a link built from it would drop the mailbox.
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return (
    // The sheet on a phone closes from the page header's sidebar toggle: no second close mark.
    <Sidebar closeButton={false}>
      {/* Rows keep their height when the content runs long (a deep folder tree): it scrolls. */}
      <SidebarContent className="*:shrink-0">
        {/* First, in the list the hover highlight runs through, centred on the page headers'
            middle (24px down: the sidebar's 8px padding and half the 32px row), so it sits on
            the same line as their titles. */}
        {/* The workspace, hugging its mark and name, and the bell at the row's end. */}
        <WorkspaceSwitcher end={<NotificationsButton />} />
        {module === "files" ? (
          <StorageNav mailbox={mailbox} />
        ) : module === "crm" ? (
          <CrmNav mailbox={mailbox} />
        ) : (
          <MailNav mailbox={mailbox} />
        )}
      </SidebarContent>

      {/* The foot: the module and its Switch. Settings is in the workspace's menu, the bell
          beside it, and the sidebar's toggle at the start of every page header. */}
      <SidebarFooter className="flex-col items-stretch">
        <OfflineBadge />
        <ModuleSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}

/** Mail's rows: search, the mailbox, the lists and the folders. */
function MailNav({ mailbox }: { mailbox: string | undefined }) {
  const { isMobile } = useSidebar();
  const shown = useShownMailbox();
  const openCompose = useOpenCompose();
  return (
    <>
      {/* Which mailbox you're in, then what you do: write and find. On a phone the sidebar is a
          sheet that unmounts when closed, so the list header holds search there instead (one
          search mounted at a time, so keys open one panel). */}
      <SidebarSection>
        <MailboxSwitcher />
        <SidebarItemTrigger onPress={openCompose} aria-keyshortcuts={ariaKeyShortcuts("compose")}>
          <IconWrite />
          <span className="min-w-0 truncate">Compose</span>
        </SidebarItemTrigger>
        {!isMobile && <SearchPopover side="start" />}
      </SidebarSection>
      {/* Where mail waits, the same rows for every mailbox the switcher shows; a shared inbox adds
          its Mine. Every row keeps the mailbox chosen: a link never changes which one is shown. */}
      <SidebarSection>
        <Items items={mail} mailbox={mailbox} />
        {shown?.kind === "shared" && <HelpdeskItems mailboxId={shown.id} />}
      </SidebarSection>
      <Group label="Folders" items={folders} mailbox={mailbox} />
    </>
  );
}

/** The mailbox the switcher shows, in the active workspace (none: all of them). */
function useShownMailbox() {
  const { member } = useMember();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const boxes =
    useWorkspaces().data?.workspaces.find((w) => w.id === member.orgId)?.mailboxes ?? [];
  return boxes.find((box) => box.id === mailbox);
}

/** A nav link that keeps showing `mailbox`, the switcher's choice. */
function withMailbox(href: string, mailbox: string | undefined) {
  if (!mailbox) return href;
  return `${href}${href.includes("?") ? "&" : "?"}mailbox=${encodeURIComponent(mailbox)}`;
}

function Group(props: { label: string; items: NavItem[]; mailbox: string | undefined }) {
  return (
    <SidebarDisclosure defaultExpanded>
      <SidebarDisclosureTrigger>{props.label}</SidebarDisclosureTrigger>
      <SidebarDisclosurePanel>
        <Items items={props.items} mailbox={props.mailbox} />
      </SidebarDisclosurePanel>
    </SidebarDisclosure>
  );
}

function Items({ items, mailbox }: { items: NavItem[]; mailbox: string | undefined }) {
  const { pathname } = useLocation();
  const { lane, view } = useSearch({ strict: false }) as { lane?: string; view?: string };
  const isCurrent = ({ current }: NavItem) =>
    !!current &&
    // A helpdesk view lives under /inbox too; its own row is the current one.
    !view &&
    (current.exact ? pathname === current.path : pathname.startsWith(current.path)) &&
    lane === current.lane;

  return items.map((item) => (
    <SidebarItem
      key={item.label}
      href={item.href && withMailbox(item.href, mailbox)}
      isCurrent={isCurrent(item)}
    >
      {item.icon}
      <SidebarLabel>{item.label}</SidebarLabel>
      {item.unread && <UnreadCount mailbox={mailbox} />}
    </SidebarItem>
  ));
}

/** Unread threads in the inbox, across the shown mailbox (or all of them); nothing at zero. */
function UnreadCount({ mailbox }: { mailbox: string | undefined }) {
  const counts = useCounts().data?.counts ?? [];
  const unread = counts
    .filter((c) => !mailbox || c.mailboxId === mailbox)
    .reduce((sum, c) => sum + c.unread, 0);
  if (!unread) return null;
  // 4px into the row's end padding: its centre lines up with the sidebar toggle's and the search
  // field's `/` above it.
  return <CountBadge count={unread} className="ms-auto -me-1" />;
}

/**
 * Shown only while the API cannot be reached. Not in the Figma frame: the smallest thing that
 * says what is going on, from the existing badge and its warning tokens. Actions taken meanwhile
 * are queued and counted.
 */
function OfflineBadge() {
  const { online, queued } = useConnectivity();
  if (online) return null;
  return (
    <Badge intent="warning" role="status" className="ms-2 mb-1 self-start tabular-nums">
      {queued > 0 ? `Offline · ${queued} queued` : "Offline"}
    </Badge>
  );
}
