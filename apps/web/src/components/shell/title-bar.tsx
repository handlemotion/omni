import { cn } from "cn";
import { IconSidebar } from "@/components/icons/sidebar";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { desktop } from "@/lib/desktop.ts";
import { NavArrows } from "./nav-arrows";

/**
 * The desktop app's title row, over the icon rail and the sidebar only: the traffic lights, the
 * sidebar toggle after them and the back and forward arrows at its end. With the sidebar closed
 * it runs across the window, over the page. A browser has none.
 */
export function TitleRow({ full }: { full: boolean }) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-0.5 border-b border-sidebar-border bg-shell pe-2.5 **:[--btn-overlay:var(--color-secondary)]!",
        desktop.platform === "mac" ? "ps-[75.5px]" : "ps-2.5",
        full && "fixed inset-x-0 top-0 z-35",
      )}
    >
      <SidebarToggle />
      <span className={full ? undefined : "ms-auto"}>
        <NavArrows />
      </span>
    </div>
  );
}

export function SidebarToggle({ placement }: { placement?: "right" }) {
  const { open } = useSidebar();
  const label = open ? "Close sidebar" : "Open sidebar";
  return (
    <TooltipTrigger delay={400}>
      <SidebarTrigger intent="ghost" size="sq-sm" aria-label={label}>
        <IconSidebar />
      </SidebarTrigger>
      <Tooltip placement={placement}>{label}</Tooltip>
    </TooltipTrigger>
  );
}
