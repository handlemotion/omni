// The desktop app's title-bar group (docs/spec/desktop.md, "Navigation changes in the web app"):
// at the top left of every screen, beside the macOS traffic lights, the workspace switcher as its
// mark, back and forward through the app's history, and the sidebar toggle. Not in Figma: built
// from the sidebar's own switcher and the page headers' 28px ghost buttons, nothing added. The
// rest of the row moves the window (`routeTitleBarDrags`). Not drawn in a browser.
import { useRouter } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons/central";
import { IconSidebar } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useHistoryEnds } from "@/hooks/use-history-ends.ts";
import { desktop } from "@/lib/desktop.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { WorkspaceSwitcher } from "./module-switcher";

/** The group's width, for the rows it sits over to leave room: `var(--title-bar-width)`. */
const WIDTH_VAR = "--title-bar-width";

export function DesktopTitleBar() {
  const { history } = useRouter();
  const ends = useHistoryEnds();
  const sidebar = useSidebar();
  const open = sidebar.isMobile ? sidebar.isOpenOnMobile : sidebar.open;
  const group = useRef<HTMLDivElement>(null);

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
  }, []);

  return (
    <div
      ref={group}
      // macOS: the traffic lights sit in the first 76px, on this row's centre line (the shell
      // places them). Elsewhere the group starts where the sidebar's rows do.
      className={`fixed start-0 top-0 z-20 flex h-12 items-center gap-0.5 pe-1 ${desktop.platform === "mac" ? "ps-19" : "ps-2"}`}
    >
      <WorkspaceSwitcher iconOnly />
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label="Back"
        aria-keyshortcuts={ariaKeyShortcuts("back")}
        isDisabled={!ends.back}
        onPress={() => history.back()}
      >
        <IconChevronLeft />
      </Button>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label="Forward"
        aria-keyshortcuts={ariaKeyShortcuts("forward")}
        isDisabled={!ends.forward}
        onPress={() => history.forward()}
      >
        <IconChevronRight />
      </Button>
      <SidebarTrigger
        intent="ghost"
        size="sq-sm"
        aria-label={open ? "Close sidebar" : "Open sidebar"}
      >
        <IconSidebar />
      </SidebarTrigger>
    </div>
  );
}

/**
 * Room for the title-bar group in a row it sits over: the sidebar's top row, or a page header
 * while the sidebar is closed. `inset` is how far in from the window's edge the row's content
 * starts, which the group already covers.
 */
export function TitleBarSpace({ inset }: { inset: number }) {
  return (
    <div
      aria-hidden
      className="shrink-0 self-stretch"
      style={{ width: `calc(var(${WIDTH_VAR}, 0px) - ${inset}px)` }}
    />
  );
}
