// The start of every page header in the app shell: the sidebar's toggle, left of the title, open
// or closed (on a phone, the sidebar sheet's).
// Except on a phone the title bar holds the toggle; with the sidebar closed, the header leaves
// room for the title bar's group instead.
import { IconSidebar } from "@/components/icons/sidebar";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { TitleBarSpace, useTitleBar } from "./title-bar";

function useSidebarOpen() {
  const sidebar = useSidebar();
  return sidebar.isMobile ? sidebar.isOpenOnMobile : sidebar.open;
}

/**
 * Whether page headers start with the sidebar toggle (or the title bar's room): always on a phone;
 * elsewhere while the sidebar is closed.
 */
export function usePageNavShown() {
  const open = useSidebarOpen();
  return !useTitleBar() || !open;
}

export function PageNav() {
  const open = useSidebarOpen();
  const titleBar = useTitleBar();
  if (titleBar) return open ? null : <TitleBarSpace inset={10} />;
  return (
    // 4px more before the title than the header's own 8px gap, so the title reads as the start
    // of the page, not a second button. 2px in from the header's 10px (optical): the glyph's ink
    // then starts 20px from the pane's edge, on the content's line below it (measured).
    <div className="ms-0.5 me-1 flex shrink-0 items-center">
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
