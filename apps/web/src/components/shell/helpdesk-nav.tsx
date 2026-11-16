// A shared inbox's helpdesk views (ADR 0021). The sidebar shows only the one mail's own rows
// don't already cover, Mine, in the same group as Inbox and Later, for the shared inbox the
// mailbox switcher shows. The Inbox holds every conversation until you mark it done (ADR 0032),
// so it is already the team's whole queue.
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
import { SidebarItem, SidebarLabel } from "@/components/ui/sidebar";
import { useConversationCounts } from "@/hooks/use-conversation.ts";
import type { HelpdeskView } from "@/lib/types.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { workspaceHref } from "@/lib/workspaces.ts";

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

/** The shared inbox's Mine row, with its count. */
export function HelpdeskItems(props: { mailboxId: string }) {
  const counts = useConversationCounts().data?.find((c) => c.mailboxId === props.mailboxId);
  const workspace = useWorkspaceSlug();
  const { pathname } = useLocation();
  const search = useSearch({ strict: false }) as { mailbox?: string; view?: string; tag?: string };
  const here =
    pathname.startsWith(workspaceHref(workspace, "/mail/inbox")) &&
    search.mailbox === props.mailboxId &&
    !search.tag;
  return VIEW_NAV.flatMap(({ view, label, icon }) => {
    // The only view mail's own rows don't already cover.
    if (view !== "mine") return [];
    const count = counts?.views[view] ?? 0;
    return (
      <SidebarItem
        key={view}
        href={workspaceHref(
          workspace,
          `/mail/inbox?mailbox=${encodeURIComponent(props.mailboxId)}&view=${view}`,
        )}
        isCurrent={here && search.view === view}
        tooltip={label}
      >
        {({ isCollapsed }) => (
          <>
            {icon}
            <SidebarLabel>{label}</SidebarLabel>
            {count > 0 && !isCollapsed && (
              <span className="ms-auto text-xs text-muted-foreground tabular-nums">{count}</span>
            )}
          </>
        )}
      </SidebarItem>
    );
  });
}
