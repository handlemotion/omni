import { useLocation, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  IconConnections,
  IconLogOut,
  IconSettings,
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
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Avatar } from "@/components/ui/avatar";
import { useMember, useSignOut } from "@/hooks/use-session.ts";
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
 * The white island's left part, floating on the shell's grey under the top rail: the rail of
 * modules (with Search, and your picture at its foot for settings) and, when open, the sidebar:
 * the module's name (Calendar goes without, its month is the title), its own pages, and the
 * workspace switcher at its foot.
 */
export function RailSidebar({ title, children }: { title?: string; children: ReactNode }) {
  const { open } = useSidebar();
  return (
    <div className="peer mt-12 flex shrink-0 overflow-hidden rounded-s-xl border-y border-s border-sidebar-border bg-background">
      <div className="flex w-13 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border py-3">
        <ModuleTabs />
        <SearchButton />
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
          className="h-auto border-e border-sidebar-border bg-background"
        >
          <SidebarContent className="gap-3 p-3 *:shrink-0">
            <SidebarTitle title={title} />
            {children}
            <div className="mt-auto">
              <WorkspaceSwitcher workspacesOnly foot />
            </div>
          </SidebarContent>
        </Sidebar>
      )}
    </div>
  );
}

function SidebarTitle({ title }: { title?: string }) {
  const modules = useModules();
  const module = usePressedModule();
  const name =
    title ?? (module === "calendar" ? undefined : modules.find((m) => m.id === module)?.label);
  if (!name) return null;
  return <h2 className="-mb-1 flex h-7 items-center px-2 text-md">{name}</h2>;
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
  const { user } = useMember();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const openSettings = useOpenSettings();
  const signOut = useSignOut();
  return (
    <MenuTrigger>
      <SidebarItemTrigger
        aria-label="Settings"
        className={cn(
          "size-8 justify-center rounded-full px-0",
          inSettings && "[--btn-bg:var(--sidebar-accent)]",
        )}
      >
        <Avatar
          src={user.image ?? null}
          initials={(user.name || user.email).slice(0, 1).toUpperCase()}
          alt=""
          className="bg-secondary text-muted-foreground outline-0"
          style={{ "--avatar-size": "24px" } as CSSProperties}
        />
      </SidebarItemTrigger>
      <Menu placement="top start" popover={{ offset: 6, className: "w-56" }}>
        <MenuItem
          id="account"
          textValue="Account settings"
          onAction={() => openSettings("profile")}
        >
          <IconUserRound data-slot="icon" />
          <MenuLabel>Account settings</MenuLabel>
        </MenuItem>
        <MenuItem
          id="workspace"
          textValue="Workspace settings"
          onAction={() => openSettings("general")}
        >
          <IconSettings data-slot="icon" />
          <MenuLabel>Workspace settings</MenuLabel>
        </MenuItem>
        <MenuItem
          id="connections"
          textValue="Connections"
          onAction={() => openSettings("accounts")}
        >
          <IconConnections data-slot="icon" />
          <MenuLabel>Connections</MenuLabel>
        </MenuItem>
        <MenuSeparator />
        <MenuItem id="log-out" textValue="Log out" onAction={() => signOut.mutate()}>
          <IconLogOut data-slot="icon" />
          <MenuLabel>Log out</MenuLabel>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
