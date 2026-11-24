import { IconSearch, IconSidebar } from "@/components/icons/sidebar";
import { openSearch } from "@/components/search/command-menu";
import { contextMenuProps } from "@/components/ui/context-menu";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { PresenceStack } from "@/components/talk/presence-stack";
import { usePageTabsSync } from "@/hooks/use-page-tabs.ts";
import { desktop } from "@/lib/desktop.ts";
import { NotificationsButton } from "./notifications";
import { WorkspaceSwitcher } from "./module-switcher";
import { PageTabs } from "./page-tabs";
import { useWindowControls } from "./window-controls";

/**
 * The top rail, on the shell's grey over the white island (not on a phone). Its left edge holds
 * the sidebar toggle (past the traffic lights in the desktop app) and the workspace switcher; its middle the open pages as tabs; its right edge who is online now and
 * notifications (and, on Windows, room for the window controls past them).
 */
export function TitleBar() {
  const { isMobile, open, toggleSidebar } = useSidebar();
  const controls = useWindowControls();
  usePageTabsSync();
  if (isMobile) return null;
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
      className={`fixed inset-x-0 top-0 z-35 grid h-12 grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)] items-center gap-2 bg-shell ${controls ? "pe-36.5" : "pe-2.5"} **:[--btn-overlay:var(--color-secondary)]! **:aria-expanded:[--btn-bg:var(--color-secondary)]! ${desktop.platform === "mac" ? "ps-[85.5px]" : "ps-[14.5px]"}`}
    >
      <span className="flex items-center gap-0.5 justify-self-start">
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
        <span className="ms-2 flex">
          <WorkspaceSwitcher chevron />
        </span>
      </span>
      <span className="flex min-w-0 justify-self-center">
        <PageTabs />
      </span>
      <span className="flex items-center gap-0.5 justify-self-end">
        <PresenceStack />
        <NotificationsButton />
      </span>
    </div>
  );
}
