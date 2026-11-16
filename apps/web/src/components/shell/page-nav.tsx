// The start of every page header in the app shell while the sidebar is closed: the toggle that
// opens it again (on a phone, the sidebar sheet). With the sidebar open its toggle sits in the
// sidebar's footer instead, and the header starts with the title.
import { IconSidebar } from "@/components/icons/sidebar";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

/** Whether page headers start with the sidebar toggle: on a phone, or with the sidebar closed. */
export function usePageNavShown() {
  const sidebar = useSidebar();
  return sidebar.isMobile || !sidebar.open;
}

export function PageNav() {
  const sidebar = useSidebar();
  if (!usePageNavShown()) return null;
  const open = sidebar.isMobile && sidebar.isOpenOnMobile;
  return (
    // 4px more before the title than the header's own 8px gap, so the title reads as the start
    // of the page, not a second button.
    <div className="me-1 flex shrink-0 items-center">
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
