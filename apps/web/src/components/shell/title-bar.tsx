import { useLayoutEffect, useRef } from "react";
import { IconSidebar } from "@/components/icons/sidebar";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { desktop } from "@/lib/desktop.ts";
import { WorkspaceSwitcher } from "./module-switcher";
import { NotificationsButton } from "./notifications";

const WIDTH_VAR = "--title-bar-width";

/** Whether the title row is drawn: everywhere but a phone. */
export function useTitleBar() {
  return !useSidebar().isMobile;
}

export function TitleBar() {
  const sidebar = useSidebar();
  const open = sidebar.isMobile ? sidebar.isOpenOnMobile : sidebar.open;
  const group = useRef<HTMLDivElement>(null);
  const shown = !sidebar.isMobile;

  useLayoutEffect(() => {
    const element = group.current;
    if (!element) return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() =>
      root.setProperty(WIDTH_VAR, `${element.getBoundingClientRect().right}px`),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.removeProperty(WIDTH_VAR);
    };
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={group}
      className={`fixed start-0 top-0 z-35 flex h-12 items-center gap-0.5 ${desktop.platform === "mac" ? "ps-21" : "ps-[9.5px]"} ${open ? "w-(--sidebar-width) pe-[7.5px]" : "pe-1"}`}
    >
      <SidebarTrigger
        intent="ghost"
        size="sq-sm"
        aria-label={open ? "Close sidebar" : "Open sidebar"}
      >
        <IconSidebar />
      </SidebarTrigger>
      <span className={open ? "ms-auto flex items-center gap-0.5" : "flex items-center gap-1.5"}>
        <NotificationsButton />
        <WorkspaceSwitcher iconOnly />
      </span>
    </div>
  );
}

/**
 * The sidebar's first row: the title bar's, so its own rows start under it (not on a phone). 28px,
 * between a full 32px row and 24px, which crowded the title bar.
 */
export function TitleBarRow() {
  return useTitleBar() ? <div aria-hidden className="h-7 shrink-0" /> : null;
}

/**
 * Room for the title-bar group in a page header while the sidebar is closed. `inset` is how far in from the window's edge the row's content
 * starts, which the group already covers.
 */
export function TitleBarSpace({
  inset,
  afterIsland = true,
}: {
  inset: number;
  afterIsland?: boolean;
}) {
  const island = afterIsland ? " - var(--sidebar-island-width, 0px)" : "";
  return (
    <div
      aria-hidden
      className="shrink-0 self-stretch"
      style={{ width: `max(0px, calc(var(${WIDTH_VAR}, 0px) - ${inset}px${island}))` }}
    />
  );
}
