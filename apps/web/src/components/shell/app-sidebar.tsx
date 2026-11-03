import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconChevronLeft,
  IconChevronRight,
  IconCircleDashed,
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
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { MailboxSwitcher } from "./mailbox-switcher";
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
import { useSignOut } from "@/hooks/use-session.ts";

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
  const signOut = useSignOut();
  return (
    <Sidebar>
      <SidebarHeader>
        <MailboxSwitcher />
        <div className="flex items-center gap-0.5">
          <Button
            intent="plain"
            size="sq-xs"
            aria-label="Back"
            onPress={() => router.history.back()}
          >
            <IconChevronLeft />
          </Button>
          <Button
            intent="plain"
            size="sq-xs"
            aria-label="Forward"
            onPress={() => router.history.forward()}
          >
            <IconChevronRight />
          </Button>
          <SidebarTrigger size="sq-xs">
            <IconSidebar />
          </SidebarTrigger>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* The first group needs no heading: it's what the app opens to. */}
        <SidebarSection>
          <Items items={mail} />
        </SidebarSection>
        <Group label="Folders" items={folders} />
      </SidebarContent>

      <SidebarFooter className="justify-between">
        <div className="flex items-center gap-0.5">
          <Button
            intent="plain"
            size="xs"
            isPending={signOut.isPending}
            onPress={() => signOut.mutate()}
          >
            <IconCircleDashed />
            Log Out
          </Button>
          <Link href="/settings" className={buttonStyles({ intent: "plain", size: "xs" })}>
            <IconSettings />
            Settings
          </Link>
        </div>
        <OfflineBadge />
        <Button intent="plain" size="sq-xs" aria-label="Help">
          <IconHelp />
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

function Group({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <SidebarDisclosure defaultExpanded>
      <SidebarDisclosureTrigger>{label}</SidebarDisclosureTrigger>
      <SidebarDisclosurePanel>
        <Items items={items} />
      </SidebarDisclosurePanel>
    </SidebarDisclosure>
  );
}

function Items({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const { lane } = useSearch({ strict: false }) as { lane?: string };
  const isCurrent = ({ current }: NavItem) =>
    !!current &&
    (current.exact ? pathname === current.path : pathname.startsWith(current.path)) &&
    lane === current.lane;

  return items.map((item) => (
    <SidebarItem key={item.label} href={item.href} isCurrent={isCurrent(item)}>
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
