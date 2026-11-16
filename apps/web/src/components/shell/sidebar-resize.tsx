import { createContext, use, useState, type ReactNode } from "react";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { desktop } from "@/lib/desktop.ts";

// 275px by default (the `--spacing-sidebar` token), 200 to 420px when dragged. A width someone
// dragged to is kept in this browser and wins over the default. In the desktop app on macOS, at
// least 240px: the title bar's group (traffic lights included) is 198px wide and sits over the
// sidebar's top row, which still needs room for the bell after it.
const SIDEBAR_WIDTH = 275;
const SIDEBAR_MIN = desktop.platform === "mac" ? 240 : 200;
const SIDEBAR_MAX = 420;

const WidthContext = createContext<
  (ReturnType<typeof useStoredWidth> & { setResizing: (resizing: boolean) => void }) | null
>(null);

/**
 * The sidebar provider with a width the person can drag, remembered in this browser. The grip
 * sits on the sidebar's edge at the start of the page beside it (`SidebarResizeGrip`).
 */
export function ResizableSidebarProvider({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const sidebar = useStoredWidth("omni:sidebar-width", SIDEBAR_WIDTH, SIDEBAR_MIN, SIDEBAR_MAX);
  const [resizing, setResizing] = useState(false);
  return (
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebar.width}px` } as React.CSSProperties}
      className={`${className ?? ""} ${resizing ? "cursor-ew-resize select-none" : ""}`}
    >
      <WidthContext value={{ ...sidebar, setResizing }}>{children}</WidthContext>
    </SidebarProvider>
  );
}

/** The sidebar's resize grip. Place it first in the page beside the sidebar (positioned). */
export function SidebarResizeGrip() {
  const sidebar = use(WidthContext);
  const { open, isMobile } = useSidebar();
  if (!sidebar || !open || isMobile) return null;
  return (
    <ResizeGrip
      label="Resize sidebar"
      width={() => sidebar.width}
      onResize={sidebar.set}
      onReset={sidebar.reset}
      onResizingChange={sidebar.setResizing}
    />
  );
}
