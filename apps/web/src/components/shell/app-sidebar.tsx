import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconEmail,
  IconHelp,
  IconSettings,
  IconInbox,
  IconPaperPlane,
  IconSidebar,
  IconTrash,
  IconWarning,
  IconWrite,
} from "@/components/icons/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchPopover } from "@/components/search/search-popover";
import { HelpdeskItems } from "./helpdesk-nav";
import { MailboxSwitcher } from "./mailbox-switcher";
import { CountBadge } from "./count-badge";
import { NotificationsButton } from "./notifications";
import {
  Sidebar,
  SidebarContent,
  SidebarDisclosure,
  SidebarDisclosurePanel,
  SidebarDisclosureTrigger,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useConnectivity } from "@/hooks/use-connectivity.ts";
import { useCounts } from "@/hooks/use-mail.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { openSettings } from "@/hooks/use-settings-dialog.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";

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

// Figma: Omni, sidebar (node 1:3).
export function AppSidebar() {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const shown = useShownMailbox();
  // The links carry the URL's mailbox as it is, not the one found in the workspace list: right
  // after a switch that list is still loading, and a link built from it would drop the mailbox.
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return (
    <Sidebar>
      {/* The switcher fills the row up to the icons, as close as they sit to each other. 2px
          down: the row's centre (24px) meets the list and reading headers' (23.5px), so the
          sidebar's icons sit on the same line as their toolbars. */}
      <SidebarHeader className="justify-between gap-0.5 pt-0.5">
        <MailboxSwitcher />
        <div className="flex items-center gap-0.5">
          <Button
            intent="ghost"
            size="sq-sm"
            aria-label="Back"
            onPress={() => router.history.back()}
          >
            <IconChevronLeft />
          </Button>
          <Button
            intent="ghost"
            size="sq-sm"
            aria-label="Forward"
            onPress={() => router.history.forward()}
          >
            <IconChevronRight />
          </Button>
          <SidebarTrigger intent="ghost" size="sq-sm">
            <IconSidebar />
          </SidebarTrigger>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* The first group needs no heading: it's what the app opens to. The same rows for every
            mailbox the switcher shows; a shared inbox adds its Mine. Every row
            keeps the switcher's choice: a link never changes which mailbox is shown. */}
        {/* Search first, as wide as the links under it, the content's 12px gap above them; its
            box grows out to the right. */}
        {/* On a phone the sidebar is a sheet that unmounts when closed: the list header holds
            search there instead (one search mounted at a time, so keys open one panel). */}
        {!isMobile && <SearchPopover side="start" />}
        <SidebarSection>
          <Items items={mail} mailbox={mailbox} />
          {shown?.kind === "shared" && <HelpdeskItems mailboxId={shown.id} />}
        </SidebarSection>
        <Group label="Folders" items={folders} mailbox={mailbox} />
      </SidebarContent>

      <SidebarFooter className="justify-between">
        <div className="flex items-center gap-0.5">
          <Button
            intent="ghost"
            size="sm"
            aria-keyshortcuts={ariaKeyShortcuts("settings")}
            onPress={() => openSettings()}
          >
            <IconSettings />
            Settings
          </Button>
        </div>
        <OfflineBadge />
        <div className="flex items-center gap-0.5">
          <NotificationsButton />
          <Button intent="ghost" size="sq-sm" aria-label="Help">
            <IconHelp />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
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
    <Badge intent="warning" role="status" className="tabular-nums">
      {queued > 0 ? `Offline · ${queued} queued` : "Offline"}
    </Badge>
  );
}
