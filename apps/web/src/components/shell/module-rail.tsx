import { useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { type ComponentType, type ReactNode } from "react";
import { IconChevronDown, IconCircleCheckFilled } from "@/components/icons/central";
import {
  IconCalendarMark,
  IconCrmMark,
  IconDriveMark,
  IconMailMark,
  IconMeetingsMark,
} from "@/components/icons/module-marks";
import { SearchButton } from "@/components/search/search-trigger";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Sidebar, SidebarContent, SidebarItemTrigger } from "@/components/ui/sidebar";
import { isSettingsPath } from "@/hooks/use-settings.ts";
import { desktop } from "@/lib/desktop.ts";
import {
  useModulePress,
  useModules,
  useOpenModule,
  usePressedModule,
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
 * The sidebar, a very subtle off-white beside the white page, and always open. Its top row, in line with the page's
 * own header, holds the module switcher and, opposite it, notifications and Search; in the desktop
 * app the traffic lights sit at its start and the switcher is centred between them and the icons.
 * Then the module's own pages, and the workspace switcher at its foot, whose menu also holds
 * settings and Log out.
 */
export function RailSidebar({ children }: { children: ReactNode }) {
  const app = desktop.isDesktop;
  return (
    <Sidebar
      collapsible="none"
      closeButton={false}
      data-state="expanded"
      className="peer h-auto shrink-0 border-e border-sidebar-border bg-sidebar"
    >
      <SidebarContent className="gap-3 px-3 pt-0 pb-3 *:shrink-0">
        {app ? (
          <div
            className={cn(
              "-mb-3 flex h-12 items-center gap-1",
              desktop.platform === "mac" ? "-ms-3 ps-[76px]" : "",
            )}
          >
            <span className="flex min-w-0 flex-1 justify-center">
              <ModuleSwitch />
            </span>
            <TopActions />
          </div>
        ) : (
          <div className="-mb-3 flex h-12 items-center gap-1">
            <ModuleSwitch large />
            <span className="ms-auto">
              <TopActions />
            </span>
          </div>
        )}
        {children}
        <div className="mt-auto flex flex-col gap-2">
          <UpdateRow />
          <WorkspaceSwitcher foot />
        </div>
      </SidebarContent>
    </Sidebar>
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

function ModuleSwitch({ large = false }: { large?: boolean }) {
  const modules = useModules();
  const pressed = usePressedModule();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const current = inSettings ? null : pressed;
  const openModule = useOpenModule();
  const press = useModulePress();
  const module = modules.find((m) => m.id === pressed);
  const Mark = MARKS[pressed];
  const name = inSettings ? "Settings" : (module?.label ?? "");
  return (
    <MenuTrigger>
      <SidebarItemTrigger
        aria-label={`Switch module, currently ${name}`}
        className={cn(
          "w-auto max-w-full shrink",
          large ? "h-8 gap-1.5 ps-1.5 pe-1.5" : "h-8 gap-2 px-2",
        )}
      >
        <Mark className={large ? "size-4.5!" : undefined} />
        <span className={cn("min-w-0 truncate", large ? "text-lg" : "text-md")}>{name}</span>
        <IconChevronDown
          className={cn(
            "-ms-0.5 shrink-0 text-muted-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground",
            large ? "size-4! [&_path]:stroke-2" : "size-3.5!",
          )}
        />
      </SidebarItemTrigger>
      <Menu placement="bottom" popover={{ offset: 4, className: "w-60" }}>
        {modules.map((m) => {
          const ItemMark = MARKS[m.id];
          return (
            <MenuItem
              key={m.id}
              id={`module-${m.id}`}
              textValue={m.label}
              className="pe-2"
              onAction={() => {
                if (m.id === current) return;
                press(m.id);
                void openModule(m.id);
              }}
            >
              <ItemMark data-slot="icon" className="size-4.5" />
              <Checked name={m.label} current={m.id === current} />
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

function Checked({ name, current }: { name: string; current: boolean }) {
  return (
    <MenuLabel className="col-[2/-1] flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {current && <IconCircleCheckFilled className="size-4 shrink-0 text-primary" />}
    </MenuLabel>
  );
}
