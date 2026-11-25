import { useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { type ComponentType, type ReactNode } from "react";
import {
  IconCalendarMark,
  IconCrmMark,
  IconDriveMark,
  IconMailMark,
  IconMeetingsMark,
} from "@/components/icons/module-marks";
import { SearchButton } from "@/components/search/search-trigger";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { isSettingsPath } from "@/hooks/use-settings.ts";
import { desktop } from "@/lib/desktop.ts";
import {
  useModulePress,
  useModules,
  useOpenModule,
  usePressedModule,
  warmModule,
  WorkspaceSwitcher,
  type ModuleId,
} from "./module-switcher";
import { NotificationsButton } from "./notifications";
import { UpdateRow } from "./update-row";

const MARKS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  mail: IconMailMark,
  files: IconDriveMark,
  crm: IconCrmMark,
  calendar: IconCalendarMark,
  meetings: IconMeetingsMark,
};

/**
 * The shell's left edge: the rail, then the sidebar, both on the sidebar's off-white with a
 * hairline after each. The rail holds the workspace's mark (its menu switches workspaces and holds
 * settings and Log out) and, under it, a tile per module, marks only. The sidebar's top row, in
 * line with the page's own header, names the module on screen and, opposite it, holds
 * notifications and Search; then the module's own pages. In the macOS app the traffic lights sit
 * over the top of the rail and the row's start, so the rail's tiles start under the row.
 */
export function RailSidebar({ children }: { children: ReactNode }) {
  const mac = desktop.isDesktop && desktop.platform === "mac";
  return (
    <>
      <ModuleRail />
      <Sidebar
        collapsible="none"
        closeButton={false}
        data-state="expanded"
        className="peer h-auto shrink-0 border-e border-sidebar-border bg-sidebar"
      >
        <SidebarContent className="gap-3 px-3 pt-0 pb-3 *:shrink-0">
          <div className={cn("-mb-3 flex h-bar items-center gap-1", mac && "ps-2")}>
            <ModuleTitle />
            <span className="ms-auto">
              <TopActions />
            </span>
          </div>
          {children}
          <div className="mt-auto flex flex-col gap-2 empty:hidden">
            <UpdateRow />
          </div>
        </SidebarContent>
      </Sidebar>
    </>
  );
}

function TopActions() {
  return (
    <span className="-me-0.5 flex items-center gap-1">
      <NotificationsButton />
      <SearchButton />
    </span>
  );
}

function ModuleTitle() {
  const modules = useModules();
  const pressed = usePressedModule();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const name = inSettings ? "Settings" : (modules.find((m) => m.id === pressed)?.label ?? "");
  return <h2 className="min-w-0 truncate ps-2 text-lg">{name}</h2>;
}

function ModuleRail() {
  const mac = desktop.isDesktop && desktop.platform === "mac";
  const modules = useModules();
  const pressed = usePressedModule();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const current = inSettings ? null : pressed;
  const openModule = useOpenModule();
  const press = useModulePress();
  return (
    <nav
      aria-label="Modules"
      className={cn(
        "flex w-rail shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-sidebar",
        mac ? "pt-bar" : "pt-1.5",
      )}
    >
      <WorkspaceSwitcher rail />
      <span className={cn("flex flex-col items-center gap-1.5 pt-0.5")}>
        {modules.map((m) => {
          const Mark = MARKS[m.id];
          return (
            <TooltipTrigger key={m.id} delay={400}>
              <Button
                intent="ghost"
                size="sq-md"
                aria-label={m.label}
                aria-current={m.id === current ? "page" : undefined}
                className="*:[svg]:size-4.5 aria-[current=page]:[--btn-bg:var(--color-sidebar-accent)] aria-[current=page]:[--btn-overlay:var(--color-sidebar-accent)]"
                onPointerEnter={() => warmModule(m.id)}
                onPress={() => {
                  if (m.id === current) return;
                  press(m.id);
                  void openModule(m.id);
                }}
              >
                <Mark />
              </Button>
              <Tooltip placement="right">{m.label}</Tooltip>
            </TooltipTrigger>
          );
        })}
      </span>
    </nav>
  );
}
