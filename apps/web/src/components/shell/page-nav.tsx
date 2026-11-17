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
