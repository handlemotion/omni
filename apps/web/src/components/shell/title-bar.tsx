import { IconSearch, IconSidebar } from "@/components/icons/sidebar";
import { openSearch } from "@/components/search/command-menu";
import { contextMenuProps } from "@/components/ui/context-menu";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { PresenceStack } from "@/components/talk/presence-stack";
import { usePageTabsSync } from "@/hooks/use-page-tabs.ts";
import { desktop } from "@/lib/desktop.ts";
import { NotificationsButton } from "./notifications";
import { NavArrows } from "./nav-arrows";
import { PageTabs } from "./page-tabs";
import { useWindowControls } from "./window-controls";

/**
 * The top rail, in the desktop app only (a browser goes without it, and so without page tabs), on
 * the shell's grey over the rails and the page. Its left edge holds the sidebar toggle (past the
 * traffic lights) and the back and forward arrows; its middle the open pages as tabs; its right edge who is online now and
 * notifications (and, on Windows, room for the window controls past them).
 */
export function TitleBar() {
  const { isMobile } = useSidebar();
  if (isMobile || !desktop.isDesktop) return null;
  return <DesktopTitleBar />;
}

function DesktopTitleBar() {
  const { open, toggleSidebar } = useSidebar();
  const controls = useWindowControls();
  usePageTabsSync();
  const menu = contextMenuProps((target) =>
    target.closest("button, a, [role=group], [role=tab]")
      ? null
      : [
          {
            icon: IconSidebar,
            label: open ? "Close sidebar" : "Open sidebar",
            onAction: toggleSidebar,
          },
          { icon: IconSearch, label: "Search", onAction: () => openSearch() },
        ],
  );
  return (
    <div
      {...menu}
      className={`fixed inset-x-0 top-0 z-35 grid h-12 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center gap-2 bg-shell px-2.5 **:[--btn-overlay:var(--color-secondary)]! **:aria-expanded:[--btn-bg:var(--color-secondary)]!`}
    >
      <span
        className={`flex items-center gap-0.5 justify-self-start ${desktop.platform === "mac" ? "ms-[75.5px]" : "ms-1"}`}
      >
        <TooltipTrigger delay={400}>
          <SidebarTrigger
            intent="ghost"
            size="sq-sm"
            aria-label={open ? "Close sidebar" : "Open sidebar"}
          >
            <IconSidebar />
          </SidebarTrigger>
          <Tooltip>{open ? "Close sidebar" : "Open sidebar"}</Tooltip>
        </TooltipTrigger>
        <NavArrows />
      </span>
      <span className="flex min-w-0 justify-self-center">
        <PageTabs />
      </span>
      <span className={`flex items-center gap-0.5 justify-self-end ${controls ? "me-34" : ""}`}>
        <PresenceStack />
        <NotificationsButton />
      </span>
    </div>
  );
}
