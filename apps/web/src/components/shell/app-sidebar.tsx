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
  IconStar,
  IconTrash,
  IconWarning,
} from "@/components/icons/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpdeskItems } from "./helpdesk-nav";
import { MailboxSwitcher } from "./mailbox-switcher";
import { Notifications } from "./notifications";
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
} from "@/components/ui/sidebar";
import { useConnectivity } from "@/hooks/use-connectivity.ts";
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
}

const mail: NavItem[] = [
  { label: "Inbox", icon: <IconInbox />, href: "/inbox", current: { path: "/inbox" } },
  { label: "Queue", icon: <IconClock />, href: "/queue", current: { path: "/queue" } },
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
  { label: "Favorite", icon: <IconStar /> },
  { label: "Sent", icon: <IconPaperPlane /> },
  { label: "Trash", icon: <IconTrash /> },
  { label: "Spam", icon: <IconWarning /> },
];

// Figma: Omni, sidebar (node 1:3).
export function AppSidebar() {
  const router = useRouter();
  const shown = useShownMailbox();
  return (
    <Sidebar>
      <SidebarHeader>
        <MailboxSwitcher />
        <div className="flex items-center gap-0.5">
          <Button
            intent="ghost"
            size="sq-xs"
            aria-label="Back"
            onPress={() => router.history.back()}
          >
            <IconChevronLeft />
          </Button>
          <Button
            intent="ghost"
            size="sq-xs"
            aria-label="Forward"
            onPress={() => router.history.forward()}
          >
            <IconChevronRight />
          </Button>
          <SidebarTrigger intent="ghost" size="sq-xs">
            <IconSidebar />
          </SidebarTrigger>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* The first group needs no heading: it's what the app opens to. The same rows for every
            mailbox the switcher shows; a shared inbox adds its Mine. Every row
            keeps the switcher's choice: a link never changes which mailbox is shown. */}
        <SidebarSection>
          <Items items={mail} mailbox={shown?.id} />
          {shown?.kind === "shared" && <HelpdeskItems mailboxId={shown.id} />}
        </SidebarSection>
        <Group label="Folders" items={folders} mailbox={shown?.id} />
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
          <Notifications />
          <Button intent="ghost" size="sq-xs" aria-label="Help">
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
    </SidebarItem>
  ));
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
