// The start of every page header in the app shell: Back, Forward and the sidebar toggle, in that
// order, so the sidebar's top is the module alone. The toggle stays here with the sidebar
// collapsed, to open it again; on a phone it opens the sidebar sheet.
import { useRouter } from "@tanstack/react-router";
import { IconChevronLeft, IconChevronRight, IconSidebar } from "@/components/icons/sidebar";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

export function PageNav() {
  const router = useRouter();
  const sidebar = useSidebar();
  const open = sidebar.isMobile ? sidebar.isOpenOnMobile : sidebar.open;
  return (
    // 2px between the three, as the sidebar's top row had them; 4px more before the title than
    // the header's own 8px gap, so the title reads as the start of the page, not a fourth button.
    <div className="me-1 flex shrink-0 items-center gap-0.5">
      <Button intent="ghost" size="sq-sm" aria-label="Back" onPress={() => router.history.back()}>
        <IconChevronLeft />
      </Button>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label="Forward"
        onPress={() => router.history.forward()}
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
