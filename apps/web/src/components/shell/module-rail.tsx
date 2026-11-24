import { useLocation, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef, type ComponentType, type ReactNode } from "react";
import {
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
import { Sidebar, SidebarContent, SidebarItem, useSidebar } from "@/components/ui/sidebar";
import { PresenceStack } from "@/components/talk/presence-stack";
import { desktop } from "@/lib/desktop.ts";
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
import { NotificationsButton } from "./notifications";
import { SidebarToggle, TitleRow } from "./title-bar";
import { UpdateTile } from "./update-row";

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
 * The shell's left side, on the shell's fill beside the white page. In the desktop app the title
 * row (traffic lights, sidebar toggle, arrows) sits over it; a browser has none, and the sidebar
 * toggle heads the icon rail instead. Below: the icon rail (the modules, settings at its foot) and,
 * when open, the sidebar: the module's name with notifications and Search, its pages, and the
 * workspace switcher with who is online at its foot.
 */
export function RailSidebar({ title, children }: { title?: string; children: ReactNode }) {
  const { open } = useSidebar();
  const app = desktop.isDesktop;
  return (
    <div
      data-title-row={app ? (open ? "side" : "full") : undefined}
      className={cn("peer flex shrink-0 flex-col", app && !open && "pt-12")}
    >
      {app && <TitleRow full={!open} />}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-13 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-shell py-3 **:[--btn-overlay:var(--color-secondary)]! **:aria-expanded:[--btn-bg:var(--color-secondary)]!">
          {!app && (
            <div className="mb-2">
              <SidebarToggle placement="right" />
            </div>
          )}
          <ModuleTabs />
          <div className="mt-auto flex flex-col items-center gap-2">
            <UpdateTile className="size-8 rounded-lg px-0" />
            <SettingsButton />
          </div>
        </div>
        {open && (
          <Sidebar
            collapsible="none"
            closeButton={false}
            data-state="expanded"
            className="border-e border-sidebar-border bg-shell **:[--btn-overlay:var(--color-secondary)]! **:aria-expanded:[--btn-bg:var(--color-secondary)]!"
          >
            <SidebarContent className="gap-3 p-3 *:shrink-0">
              <SidebarHeader title={title} />
              {children}
              <div className="mt-auto">
                <WorkspaceSwitcher foot end={<PresenceStack />} />
              </div>
            </SidebarContent>
          </Sidebar>
        )}
      </div>
    </div>
  );
}

function SidebarHeader({ title }: { title?: string }) {
  const modules = useModules();
  const module = usePressedModule();
  const name = title ?? modules.find((m) => m.id === module)?.label;
  return (
    <div className="flex h-8 items-center gap-0.5 ps-2">
      <h2 className="min-w-0 flex-1 truncate text-md font-semibold">{name}</h2>
      <NotificationsButton />
      <SearchButton />
    </div>
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
    <nav
      {...menu}
      aria-label="Modules"
      className="flex flex-col items-center gap-1"
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
        if (!inSettings && picked.id === shown) return;
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
          <TooltipTrigger key={module.id} delay={400}>
            <SidebarItem
              data-module-tab={module.id}
              href={`/${encodeURIComponent(workspace)}/${PATHS[module.id]}${keep}`}
              isCurrent={isCurrent}
              aria-label={module.label}
              className={cn(
                "size-8 shrink-0 justify-center rounded-lg px-0 *:[svg]:size-4.5",
                !isCurrent && "hover:bg-secondary",
              )}
            >
              <Mark />
            </SidebarItem>
            <Tooltip placement="right">{module.label}</Tooltip>
          </TooltipTrigger>
        );
      })}
    </nav>
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
          className="size-8 justify-center rounded-lg px-0"
        >
          {inSettings ? <IconSettingsFilled /> : <IconSettings />}
        </SidebarItem>
        <Tooltip placement="right">Settings</Tooltip>
      </TooltipTrigger>
    </div>
  );
}
