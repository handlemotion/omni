import { useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  IconChevronDown,
  IconCircleCheckFilled,
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
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Sidebar, SidebarContent, SidebarItemTrigger, useSidebar } from "@/components/ui/sidebar";
import { useMember, useSignOut } from "@/hooks/use-session.ts";
import { isSettingsPath, useOpenSettings } from "@/hooks/use-settings.ts";
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
 * The white island's left part, floating on the shell's grey under the top rail: a header in line
 * with the page's own, where the module's mark and name, with a chevron, open the module switcher; then the module's own pages; at its foot the workspace switcher, notifications, and
 * you, whose menu holds settings and Log out.
 */
export function RailSidebar({ title, children }: { title?: string; children: ReactNode }) {
  const { open } = useSidebar();
  if (!open) return null;
  return (
    <Sidebar
      collapsible="none"
      closeButton={false}
      data-state="expanded"
      className="peer mt-10 h-auto shrink-0 rounded-s-xl border-y border-s border-e border-sidebar-border bg-background"
    >
      <SidebarContent className="gap-3 px-3 pt-0 pb-3 *:shrink-0">
        <div className="-mb-3 flex h-12 items-center">
          <SwitchHeader title={title} />
        </div>
        {children}
        <div className="mt-auto flex flex-col gap-2">
          <UpdateRow />
          <div className="flex items-center gap-0.5">
            <div className="min-w-0 flex-1">
              <WorkspaceSwitcher workspacesOnly foot />
            </div>
            <NotificationsButton />
            <YouButton />
          </div>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}

function SwitchHeader({ title }: { title?: string }) {
  const modules = useModules();
  const pressed = usePressedModule();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const current = inSettings ? null : pressed;
  const openModule = useOpenModule();
  const press = useModulePress();
  const module = modules.find((m) => m.id === pressed);
  const Mark = MARKS[pressed];
  const name = title ?? module?.label ?? "";
  return (
    <MenuTrigger>
      <SidebarItemTrigger
        aria-label={`Switch module, currently ${name}`}
        className="w-auto max-w-full shrink gap-2 px-2 *:[svg]:size-5"
      >
        <Mark />
        <span className="min-w-0 truncate text-md">{name}</span>
        <IconChevronDown className="-ms-0.5 size-3.5! shrink-0 text-muted-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground" />
      </SidebarItemTrigger>
      <Menu placement="bottom start" popover={{ offset: 4, className: "w-60" }}>
        {modules.map((m) => {
          const ItemMark = MARKS[m.id];
          return (
            <MenuItem
              key={m.id}
              id={`module-${m.id}`}
              textValue={m.label}
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

function YouButton() {
  const { user } = useMember();
  const inSettings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const openSettings = useOpenSettings();
  const signOut = useSignOut();
  return (
    <MenuTrigger>
      <SidebarItemTrigger
        aria-label="Settings"
        className={cn(
          "size-8 shrink-0 justify-center rounded-full px-0",
          inSettings && "[--btn-bg:var(--sidebar-accent)]",
        )}
      >
        <Avatar
          src={user.image ?? null}
          initials={(user.name || user.email).slice(0, 1).toUpperCase()}
          alt=""
          className="bg-secondary text-muted-foreground outline-0"
          style={{ "--avatar-size": "22px" } as CSSProperties}
        />
      </SidebarItemTrigger>
      <Menu placement="top end" popover={{ offset: 4, className: "w-56" }}>
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
