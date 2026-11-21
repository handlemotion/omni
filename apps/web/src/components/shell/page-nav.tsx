import { IconSidebar } from "@/components/icons/sidebar";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

function useSidebarOpen() {
  const sidebar = useSidebar();
  return sidebar.isMobile ? sidebar.isOpenOnMobile : sidebar.open;
}

/** Whether page headers start with the sidebar toggle: on a phone, where there is no title bar. */
export function usePageNavShown() {
  return useSidebar().isMobile;
}

export function PageNav() {
  const open = useSidebarOpen();
  if (!useSidebar().isMobile) return null;
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
