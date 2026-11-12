// A shared inbox's helpdesk views in the sidebar (ADR 0021): Unassigned, Mine, Open, Pending,
// Snoozed, Resolved and SLA at risk, each with its count. The rows are the sidebar's own 32px
// items (Figma node 1:3), so a view reads like Inbox or Queue does.
import { useLocation, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconCircleCheck, IconUserCog } from "@/components/icons/central";
import {
  IconBubble,
  IconBubbleAnnotation,
  IconClock,
  IconInbox,
  IconWarning,
} from "@/components/icons/sidebar";
import {
  SidebarDisclosure,
  SidebarDisclosurePanel,
  SidebarDisclosureTrigger,
  SidebarItem,
  SidebarLabel,
} from "@/components/ui/sidebar";
import { useConversationCounts } from "@/hooks/use-conversation.ts";
import type { ConversationCounts, HelpdeskView } from "@/lib/types.ts";

type NavView = Exclude<HelpdeskView, "all">;

/** The views in navigation order, with the names the plan gives them. */
export const VIEW_NAV: { view: NavView; label: string; icon: ReactNode }[] = [
  { view: "unassigned", label: "Unassigned", icon: <IconInbox /> },
  { view: "mine", label: "Mine", icon: <IconUserCog className="size-icon" /> },
  { view: "open", label: "Open", icon: <IconBubble /> },
  { view: "pending", label: "Pending", icon: <IconBubbleAnnotation /> },
  { view: "snoozed", label: "Snoozed", icon: <IconClock /> },
  { view: "resolved", label: "Resolved", icon: <IconCircleCheck className="size-icon" /> },
  { view: "sla_at_risk", label: "SLA at risk", icon: <IconWarning /> },
];

export const viewLabel = (view: HelpdeskView) =>
  VIEW_NAV.find((v) => v.view === view)?.label ?? "All conversations";

/** Where a shared inbox opens when no view is chosen: everything still being worked on. */
export const DEFAULT_VIEW: NavView = "open";

/**
 * One shared inbox's views. `heading` puts them under a collapsible group named for the inbox
 * (when the sidebar lists several); without it they are the sidebar's first group.
 */
export function HelpdeskViews(props: { mailboxId: string; heading?: string }) {
  const counts = useConversationCounts().data?.find((c) => c.mailboxId === props.mailboxId);
  const items = <ViewItems mailboxId={props.mailboxId} counts={counts} />;
  if (!props.heading) return items;
  return (
    <SidebarDisclosure defaultExpanded>
      <SidebarDisclosureTrigger>{props.heading}</SidebarDisclosureTrigger>
      <SidebarDisclosurePanel>{items}</SidebarDisclosurePanel>
    </SidebarDisclosure>
  );
}

function ViewItems(props: { mailboxId: string; counts: ConversationCounts[number] | undefined }) {
  const { pathname } = useLocation();
  const search = useSearch({ strict: false }) as { mailbox?: string; view?: string; tag?: string };
  const here = pathname.startsWith("/inbox") && search.mailbox === props.mailboxId && !search.tag;
  const shown = here ? (search.view ?? DEFAULT_VIEW) : undefined;
  return VIEW_NAV.map(({ view, label, icon }) => {
    // Resolved only grows, so the API doesn't count it; nothing to show there.
    const count = view === "resolved" ? 0 : (props.counts?.views[view] ?? 0);
    return (
      <SidebarItem
        key={view}
        href={`/inbox?mailbox=${encodeURIComponent(props.mailboxId)}&view=${view}`}
        isCurrent={shown === view}
      >
        {icon}
        <SidebarLabel>{label}</SidebarLabel>
        {count > 0 && (
          <span
            className={`ms-auto text-xs tabular-nums ${view === "sla_at_risk" ? "text-danger-subtle-foreground" : "text-muted-foreground"}`}
          >
            {count}
          </span>
        )}
      </SidebarItem>
    );
  });
}
