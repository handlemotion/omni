import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircleDashed,
  IconClock,
  IconEmail,
  IconHelp,
  IconInbox,
  IconPaperPlane,
  IconSidebar,
  IconStar,
  IconTrash,
  IconWarning,
} from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
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
import {
  useMember,
  useOrganizations,
  useSetActiveOrganization,
  useSignOut,
} from "@/hooks/use-session.ts";

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
  { label: "Queue", icon: <IconClock />, href: "/snoozed", current: { path: "/snoozed" } },
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
  { label: "All mail", icon: <IconEmail /> },
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
        <OrganizationMenu />
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
        <Button
          intent="plain"
          size="xs"
          isPending={signOut.isPending}
          onPress={() => signOut.mutate()}
        >
          <IconCircleDashed />
          Log Out
        </Button>
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

/** The active organization; the menu switches to another one. */
function OrganizationMenu() {
  const { member } = useMember();
  const organizations = useOrganizations();
  const setActive = useSetActiveOrganization();
  const active = organizations.data?.find((org) => org.id === member.orgId);

  return (
    <MenuTrigger>
      {/* 7px instead of 8: centers the 17px logo on the same axis as the 15px icons below. */}
      <Button intent="plain" className="min-w-0 flex-1 justify-start px-1.75">
        <Avatar
          isSquare
          src={active?.logo ?? null}
          initials={active?.name.slice(0, 1)}
          className="outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.25)]"
        />
        <span className="flex items-center gap-1.25 truncate">
          {active?.name}
          <IconChevronDown className="mt-px text-subtle-foreground" />
        </span>
      </Button>
      <Menu placement="bottom start">
        {(organizations.data ?? []).map((org) => (
          <MenuItem key={org.id} onAction={() => setActive.mutate(org.id)}>
            {org.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem href="/settings">Settings</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
