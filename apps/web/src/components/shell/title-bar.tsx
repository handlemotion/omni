import { IconSearch, IconSidebar } from "@/components/icons/sidebar";
import { openSearch } from "@/components/search/command-menu";
import { contextMenuProps } from "@/components/ui/context-menu";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { desktop } from "@/lib/desktop.ts";
import { railPeek } from "./module-rail";
import { WorkspaceSwitcher } from "./module-switcher";
import { SearchButton } from "@/components/search/search-trigger";
import { PresenceStack } from "@/components/talk/presence-stack";
import { NavArrows } from "./nav-arrows";
import { NotificationsButton } from "./notifications";

/**
 * The window's top row, on the shell's grey (not on a phone): the workspace switcher past the
 * traffic lights, the sidebar toggle (resting on it while the sidebar is closed previews the nav),
 * back and forward, and at the far end the teammates online now, search, then notifications.
 */
export function TitleBar() {
  const { isMobile, open, toggleSidebar } = useSidebar();
  if (isMobile) return null;
  const menu = contextMenuProps((target) =>
    target.closest("button, a, [role=group]")
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
      className={`fixed inset-x-0 top-0 z-35 flex h-12 items-center gap-0.5 bg-shell pe-2.5 **:[--btn-overlay:var(--color-secondary)]! **:aria-expanded:[--btn-bg:var(--color-secondary)]! ${desktop.platform === "mac" ? "ps-[88px]" : "ps-[13.5px]"}`}
    >
      <WorkspaceSwitcher chevron />
      <span
        className="flex"
        onPointerEnter={open ? undefined : railPeek.enter}
        onPointerLeave={open ? undefined : railPeek.leave}
      >
        <SidebarTrigger
          intent="ghost"
          size="sq-sm"
          aria-label={open ? "Close sidebar" : "Open sidebar"}
        >
          <IconSidebar />
        </SidebarTrigger>
      </span>
      <NavArrows />
      <span className="ms-auto flex items-center gap-0.5">
        <PresenceStack />
        <SearchButton />
        <NotificationsButton />
      </span>
    </div>
  );
}
