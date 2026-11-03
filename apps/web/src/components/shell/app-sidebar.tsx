import { useLocation, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconChevronDown,
  IconClock,
  IconEmail,
  IconHelp,
  IconInbox,
  IconPaperPlane,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconStar,
  IconTrash,
  IconWarning,
} from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/menu";
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
import { useMember, useOrganizations, useSetActiveOrganization } from "@/hooks/use-session.ts";

// Figma: Omni, sidebar (node 1:3).
export function AppSidebar() {
  const { pathname } = useLocation();
  const { lane } = useSearch({ strict: false }) as { lane?: string };
  const at = (path: string, withLane?: string) => pathname.startsWith(path) && lane === withLane;

  return (
    <Sidebar>
      <SidebarHeader>
        <OrganizationMenu />
        <div className="flex items-center gap-0.5">
          <Link href="/search" aria-label="Search" className={iconLink}>
            <IconSearch />
          </Link>
          <SidebarTrigger size="sq-xs">
            <IconSidebar />
          </SidebarTrigger>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarSection>
          <Item href="/inbox" icon={<IconInbox />} isCurrent={at("/inbox")}>
            Inbox
          </Item>
          <Item href="/snoozed" icon={<IconClock />} isCurrent={at("/snoozed")}>
            Queue
          </Item>
          <Item
            href="/inbox?lane=needs_reply"
            icon={<IconBubble />}
            isCurrent={at("/inbox", "needs_reply")}
          >
            Needs reply
          </Item>
          <Item
            href="/inbox?lane=waiting_on_them"
            icon={<IconBubbleAnnotation />}
            isCurrent={at("/inbox", "waiting_on_them")}
          >
            Awaiting reply
          </Item>
        </SidebarSection>

        {/* Labels, items and destinations below are the frame's; these views don't exist yet. */}
        <SidebarDisclosure defaultExpanded>
          <SidebarDisclosureTrigger>Inbox</SidebarDisclosureTrigger>
          <SidebarDisclosurePanel>
            <Item icon={<IconEmail />}>All mail</Item>
            <Item icon={<IconStar />}>Favorite</Item>
            <Item icon={<IconPaperPlane />}>Sent</Item>
          </SidebarDisclosurePanel>
        </SidebarDisclosure>
        <SidebarDisclosure defaultExpanded>
          <SidebarDisclosureTrigger>Inbox</SidebarDisclosureTrigger>
          <SidebarDisclosurePanel>
            <Item icon={<IconTrash />}>Trash</Item>
            <Item icon={<IconWarning />}>Spam</Item>
          </SidebarDisclosurePanel>
        </SidebarDisclosure>
      </SidebarContent>

      <SidebarFooter className="gap-0.5 px-0.5">
        <Button intent="plain" size="sq-xs" aria-label="Help">
          <IconHelp />
        </Button>
        <Link href="/settings" aria-label="Settings" className={iconLink}>
          <IconSettings />
        </Link>
      </SidebarFooter>
    </Sidebar>
  );
}

// Icon links share the plain 26px button's look.
const iconLink = buttonStyles({ intent: "plain", size: "sq-xs" });

function Item(props: { href?: string; icon: ReactNode; isCurrent?: boolean; children: string }) {
  return (
    <SidebarItem href={props.href} isCurrent={props.isCurrent}>
      {props.icon}
      <SidebarLabel>{props.children}</SidebarLabel>
    </SidebarItem>
  );
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
      </Menu>
    </MenuTrigger>
  );
}
