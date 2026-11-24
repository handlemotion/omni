import { useLocation, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  IconCircleCheckFilled,
  IconConnections,
  IconSettings,
  IconSettingsFilled,
  IconUserRound,
} from "@/components/icons/central";
import {
  IconCalendarMark,
  IconCrmMark,
  IconDriveMark,
  IconMailMark,
  IconMeetingsMark,
} from "@/components/icons/module-marks";
import { SearchButton } from "@/components/search/search-trigger";
import {
  Sidebar,
  SidebarContent,
  SidebarItem,
  SidebarItemTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { isSettingsPath, useOpenSettings } from "@/hooks/use-settings.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import {
  useModules,
  useCurrentModule,
  useModulePress,
  warmModule,
  usePressedModule,
  useOpenModule,
  WorkspaceSwitcher,
  type ModuleId,
} from "./module-switcher";
import { UpdateRow, UpdateTile } from "./update-row";

const MARKS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  mail: IconMailMark,
  files: IconDriveMark,
  crm: IconCrmMark,
  calendar: IconCalendarMark,
  meetings: IconMeetingsMark,
};

const SWITCH_MS = 180;

const PATHS: Record<ModuleId, string> = {
  mail: "mail/inbox",
  files: "files",
  crm: "crm/companies",
  calendar: "calendar",
  meetings: "meetings",
};

/**
 * The sidebar, the white island's left part under the top rail: the modules as tabs (the one on
 * screen with its name) with Search at the row's end, then the module's own pages, and settings at
 * its foot. Closed, it is a rail of icons: the module on screen (its menu switches module), Search,
 * the module's pages where they fit as icons, and settings.
 */
export function RailSidebar({ title, children }: { title?: string; children: ReactNode }) {
  const { open } = useSidebar();
  return (
    <Sidebar
      collapsible="none"
      closeButton={false}
      data-state={open ? "expanded" : "collapsed"}
      className={cn(
        "peer mt-12 shrink-0 rounded-tl-2xl border-s border-t border-e border-sidebar-border bg-background",
        !open && "w-14",
      )}
    >
      <SidebarContent className="gap-3 p-3 *:shrink-0">
        {open && <WorkspaceSwitcher workspacesOnly />}
        <div className="mb-0.5">
          {open ? (
            <ModuleTabs />
          ) : (
            <div className="flex flex-col items-center gap-1">
              <ModuleMenu />
              <SearchButton />
            </div>
          )}
        </div>
        {title && open && <div className="-mb-2 flex h-7 items-center px-2 text-md">{title}</div>}
        {open
          ? children
          : !title && <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">{children}</div>}
        <div className="mt-auto flex flex-col gap-2">
          {open ? <UpdateRow /> : <UpdateTile className="size-8 rounded-lg px-0" />}
          <SettingsButton />
        </div>
      </SidebarContent>
    </Sidebar>
  );
}

function ModuleTabs() {
  const modules = useModules();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const module = usePressedModule();
  const shown = useCurrentModule();
  const current = inSettings ? null : module;
  const workspace = useWorkspaceSlug();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const keep = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";
  const openModule = useOpenModule();
  const press = useModulePress();
  const pressedAt = useRef(0);
  const menu = contextMenuProps((target) => {
    const picked = modules.find(
      (m) => m.id === target.closest("[data-module-tab]")?.getAttribute("data-module-tab"),
    );
    if (!picked) return null;
    return [
      {
        icon: MARKS[picked.id],
        label: `Open ${picked.label}`,
        onAction: () => void openModule(picked.id),
      },
    ] satisfies ContextMenuEntry[];
  }, "Module actions");

  return (
    <div className="flex items-center gap-1">
      <nav
        {...menu}
        aria-label="Modules"
        className="flex min-w-0 flex-1 items-center gap-1"
        style={{ "--switch-ms": `${SWITCH_MS}ms` } as CSSProperties}
        onPointerOver={(event) => {
          const id = (event.target as Element)
            .closest("[data-module-tab]")
            ?.getAttribute("data-module-tab");
          const picked = modules.find((m) => m.id === id);
          if (picked) warmModule(picked.id);
        }}
        onPointerDownCapture={(event) => {
          const id = (event.target as Element)
            .closest("[data-module-tab]")
            ?.getAttribute("data-module-tab");
          const picked = modules.find((m) => m.id === id);
          if (
            picked &&
            picked.id !== current &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey
          ) {
            pressedAt.current = performance.now();
            press(picked.id);
          }
        }}
        onClickCapture={(event) => {
          const id = (event.target as Element)
            .closest("[data-module-tab]")
            ?.getAttribute("data-module-tab");
          const picked = modules.find((m) => m.id === id);
          if (!picked || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (picked.id === shown) return;
          if (performance.now() - pressedAt.current > SWITCH_MS)
            pressedAt.current = performance.now();
          press(picked.id);
          const left = SWITCH_MS - (performance.now() - pressedAt.current);
          window.setTimeout(() => void openModule(picked.id), Math.max(0, left));
        }}
      >
        {modules.map((module) => {
          const isCurrent = module.id === current;
          const Mark = MARKS[module.id];
          return (
            <TooltipTrigger key={module.id} isDisabled={isCurrent}>
              <SidebarItem
                data-module-tab={module.id}
                href={`/${encodeURIComponent(workspace)}/${PATHS[module.id]}${keep}`}
                isCurrent={isCurrent}
                aria-label={module.label}
                className={cn(
                  "h-7.5 w-auto shrink-0 gap-0 rounded-lg px-1.5 *:[svg]:size-4.5",
                  !isCurrent && "hover:bg-secondary",
                )}
              >
                <Mark />
                <span
                  aria-hidden
                  className={cn(
                    "grid transition-[grid-template-columns] duration-(--switch-ms) ease-(--ease-out) motion-reduce:transition-none",
                    isCurrent ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
                  )}
                >
                  <span className="min-w-0 overflow-hidden">
                    <span className="block ps-1.5 whitespace-nowrap">{module.label}</span>
                  </span>
                </span>
              </SidebarItem>
              <Tooltip>{module.label}</Tooltip>
            </TooltipTrigger>
          );
        })}
      </nav>
      <SearchButton />
    </div>
  );
}

function ModuleMenu() {
  const modules = useModules();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const module = usePressedModule();
  const current = inSettings ? null : module;
  const openModule = useOpenModule();
  const press = useModulePress();
  const Mark = MARKS[current ?? module];
  return (
    <MenuTrigger>
      <SidebarItemTrigger
        aria-label={`Switch module, currently ${modules.find((m) => m.id === module)?.label ?? ""}`}
        className={cn(
          "size-7.5 justify-center px-0 *:[svg]:size-4.5",
          current && "[--btn-bg:var(--sidebar-accent)]",
        )}
      >
        <Mark />
      </SidebarItemTrigger>
      <Menu placement="right top" popover={{ offset: 8, className: "w-48" }}>
        {modules.map((m) => {
          const ItemMark = MARKS[m.id];
          return (
            <MenuItem
              key={m.id}
              id={m.id}
              textValue={m.label}
              className="pe-2"
              onAction={() => {
                if (m.id === current) return;
                press(m.id);
                void openModule(m.id);
              }}
            >
              <ItemMark data-slot="icon" className="size-4.5" />
              <MenuLabel className="col-[2/-1] flex min-w-0 items-center justify-between gap-3">
                <span className="truncate">{m.label}</span>
                {m.id === current && (
                  <IconCircleCheckFilled className="size-4 shrink-0 text-primary" />
                )}
              </MenuLabel>
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

function SettingsButton() {
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const openSettings = useOpenSettings();
  const menu = contextMenuProps(
    () =>
      [
        { icon: IconUserRound, label: "Account settings", onAction: () => openSettings("profile") },
        {
          icon: IconSettings,
          label: "Workspace settings",
          onAction: () => openSettings("general"),
        },
        { icon: IconConnections, label: "Connections", onAction: () => openSettings("accounts") },
      ] satisfies ContextMenuEntry[],
  );
  return (
    <div {...menu} className="flex">
      <TooltipTrigger>
        <SidebarItem
          aria-label="Settings"
          isCurrent={inSettings}
          onPress={() => openSettings("general")}
          className="size-7 w-7 justify-center rounded-lg px-0"
        >
          {inSettings ? <IconSettingsFilled /> : <IconSettings />}
        </SidebarItem>
        <Tooltip>Settings</Tooltip>
      </TooltipTrigger>
    </div>
  );
}
