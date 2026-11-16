// The sidebar's two switchers. At its top, the workspace (a company or your Personal space) as one
// row like the mailbox switcher's, whose menu switches workspace. At its foot, the module on
// screen (ADR 0035), Mail, Drive or (in a company) CRM, with Switch, whose menu switches module. The sidebar shows one
// module's rows at a time; the module follows the route. Each module has an identity colour
// (`--module-*`), used on its mark here and nowhere else.
//
// - Switching module keeps the workspace and the mailbox shown in mail.
// - Switching workspace keeps the module: Drive opens the same space's top, the CRM the same list,
//   mail the same list (`openWorkspace`); an owner or admin of a workspace still being set up goes to onboarding.
//
// Geometry: the mark is an 18px tile on the nav icons' 15px axis (1.5px out on every side), so
// its centre and the label after it line up with the rows below. The glyph is 12px, 3px in.
import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useMemo, useRef, type ComponentType, type CSSProperties } from "react";
import {
  IconCheck,
  IconChevronsUpDown,
  IconFolderFilled,
  IconHandshakeFilled,
  IconMailFilled,
  IconSettings,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useMember } from "@/hooks/use-session.ts";
import { openSettings } from "@/hooks/use-settings-dialog.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace } from "@/lib/types.ts";

export type ModuleId = "mail" | "files" | "crm";

interface Module {
  id: ModuleId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Where switching to the module lands. */
  home: "/inbox" | "/files/my" | "/crm/companies";
  /** Its identity colour, as a fill. */
  fill: string;
}

const MAIL: Module = {
  id: "mail",
  label: "Mail",
  icon: IconMailFilled,
  home: "/inbox",
  fill: "bg-module-mail",
};
/** Storage (ADR 0034), called Drive; its paths stay `/files/*`. */
const DRIVE: Module = {
  id: "files",
  label: "Drive",
  icon: IconFolderFilled,
  home: "/files/my",
  fill: "bg-module-drive",
};
/** The CRM (ADR 0036, ADR 0039): a company workspace's only; a Personal space has none. */
const CRM: Module = {
  id: "crm",
  label: "CRM",
  icon: IconHandshakeFilled,
  home: "/crm/companies",
  fill: "bg-module-crm",
};
const MODULES = [MAIL, DRIVE, CRM];
const BY_ID = { mail: MAIL, files: DRIVE, crm: CRM } as const;

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** The module a path belongs to: Drive's and the CRM's own paths, else Mail (every other shell
 *  route is mail's). */
export function moduleOf(pathname: string): ModuleId {
  if (under(pathname, "/files")) return "files";
  if (under(pathname, "/crm")) return "crm";
  return "mail";
}

export function useCurrentModule() {
  return moduleOf(useLocation().pathname);
}

function ModuleMark({ module, className }: { module: Module; className?: string }) {
  const Icon = module.icon;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4.5 shrink-0 place-items-center rounded-[5px] text-module-foreground",
        module.fill,
        className,
      )}
    >
      <Icon className="size-3 text-module-foreground" />
    </span>
  );
}

/** A workspace's square mark: its logo, or its initial on a grey a step under the hover fill. */
function WorkspaceMark({ workspace, size }: { workspace: Workspace; size: number }) {
  return (
    <Avatar
      isSquare
      src={workspace.logo}
      initials={workspace.name.slice(0, 1).toUpperCase()}
      className="bg-secondary text-foreground outline-0 mix-blend-multiply"
      style={{ "--avatar-size": `${size}px` } as CSSProperties}
    />
  );
}

/** A row's name, with the check on the current one riding inside the label so it sits on the
 *  name's line, 10px in from the row's end (as the settings workspace chooser does). */
function Label({ name, current }: { name: string; current: boolean }) {
  return (
    <MenuLabel className="flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {current && <IconCheck className="size-3.5 shrink-0 text-foreground" />}
    </MenuLabel>
  );
}

/**
 * `open(id)` goes to a module's home, keeping the workspace and the mailbox shown in mail: it
 * rides along both ways, so coming back to Mail shows the same one. The module menu and `g f`
 * both open modules through this.
 */
export function useOpenModule() {
  const router = useRouter();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return (id: ModuleId) => {
    const module = BY_ID[id];
    void router.navigate({ to: module.home, search: mailbox ? { mailbox } : {} });
  };
}

/** The sidebar's foot: the module on screen, and Switch, whose menu opens the other module. */
export function ModuleSwitcher() {
  const current = BY_ID[useCurrentModule()];
  const open = useOpenModule();
  const modules = useHasCrm() ? MODULES : MODULES.filter((module) => module.id !== "crm");
  // The menu lines up with the whole row, not the pill: the links' width, as the workspace's.
  const row = useRef<HTMLDivElement>(null);
  const rowBox = useMemo(
    () => ({ getBoundingClientRect: () => row.current?.getBoundingClientRect() ?? new DOMRect() }),
    [],
  );

  return (
    // A row on the nav rows' grid: the mark in the 15px icon box, the label 10px after it, and
    // Switch, a round pill, at the row's end.
    <div ref={row} className="flex h-8 min-w-0 items-center gap-2.5 ps-2">
      <span className="grid size-icon shrink-0 place-items-center">
        <span className="-m-[1.5px]">
          <ModuleMark module={current} />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{current.label}</span>
      <MenuTrigger>
        <Button
          intent="outline"
          size="sm"
          isCircle
          aria-label={`Switch module, currently ${current.label}`}
        >
          Switch
        </Button>
        <Menu
          placement="top start"
          popover={{
            anchor: rowBox,
            offset: 4,
            // The row sits 8px from the window's edge: the menu keeps the same 8px.
            collisionPadding: 8,
            className: "w-(--anchor-width) min-w-(--anchor-width)",
          }}
        >
          {modules.map((module) => (
            <MenuItem
              key={module.id}
              id={module.id}
              textValue={module.label}
              onAction={() => module.id !== current.id && open(module.id)}
            >
              {/* The menu's icon gap after it, which it gives only to its own marks. */}
              <ModuleMark module={module} className="me-(--me-icon)" />
              <Label name={module.label} current={module.id === current.id} />
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </div>
  );
}

/** The sidebar's top row: the workspace, and its menu: every workspace, then Settings. */
export function WorkspaceSwitcher() {
  const { member } = useMember();
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const openWorkspace = useOpenWorkspace();
  const active = workspaces.find((w) => w.id === member.orgId);
  if (!active) return null;

  const choose = (workspace: Workspace) => {
    if (workspace.id === member.orgId) return;
    openWorkspace.mutate(workspace, {
      onError: () => appToast.error("The workspace could not be opened."),
    });
  };

  return (
    <MenuTrigger>
      {/* A sidebar row like the mailbox switcher: the mark in the nav icons' 15px box, the name
          10px after it, the chevron at the row's end. */}
      <SidebarItemTrigger aria-label={`Switch workspace, currently ${active.name}`}>
        <span className="grid size-icon shrink-0 place-items-center">
          {openWorkspace.isPending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : (
            // 18px over the 15px box: the margin centres it on the nav icons' axis.
            <span className="-m-[1.5px]">
              <WorkspaceMark workspace={active} size={18} />
            </span>
          )}
        </span>
        <span className="min-w-0 truncate">{active.name}</span>
        <IconChevronsUpDown className="ms-auto -me-0.75 size-3.5 shrink-0 text-subtle-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground" />
      </SidebarItemTrigger>
      <Menu
        placement="bottom start"
        popover={{
          offset: 4,
          collisionPadding: 8,
          className: "min-w-(--anchor-width) max-w-[min(18rem,calc(100vw-16px))]",
        }}
      >
        {workspaces.map((workspace) => (
          <MenuItem
            key={workspace.id}
            id={workspace.id}
            textValue={workspace.name}
            onAction={() => choose(workspace)}
          >
            <WorkspaceMark workspace={workspace} size={20} />
            <Label name={workspace.name} current={workspace.id === member.orgId} />
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          id="settings"
          textValue="Settings"
          aria-keyshortcuts={ariaKeyShortcuts("settings")}
          onAction={() => openSettings()}
        >
          <IconSettings data-slot="icon" />
          <MenuLabel>Settings</MenuLabel>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
