// The top of the sidebar: the module on screen (ADR 0035), Mail, Drive or (in a company) CRM, whose menu switches
// module, and at the row's end the workspace's avatar, whose menu switches workspace (a company
// or your Personal space). The sidebar shows one module's rows at a time; the module follows the
// route. Each module has an identity colour (`--module-*`), used on its mark here and nowhere
// else.
//
// - Switching module keeps the workspace and the mailbox shown in mail.
// - Switching workspace keeps the module: Drive opens the same space's top, the CRM the same list,
//   mail the same list (`openWorkspace`); an owner or admin of a workspace still being set up goes to onboarding.
//
// Geometry: the mark is an 18px tile on the nav icons' 15px axis (1.5px out on every side), so
// its centre and the label after it line up with the rows below. The glyph is 12px, 3px in.
import { useLocation, useRouter, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import type { ComponentType, CSSProperties } from "react";
import { IconCheck, IconFolder, IconHandshake, IconMail } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useMember } from "@/hooks/use-session.ts";
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
  icon: IconMail,
  home: "/inbox",
  fill: "bg-module-mail",
};
/** Storage (ADR 0034), called Drive; its paths stay `/files/*`. */
const DRIVE: Module = {
  id: "files",
  label: "Drive",
  icon: IconFolder,
  home: "/files/my",
  fill: "bg-module-drive",
};
/** The CRM (ADR 0036, ADR 0039): a company workspace's only; a Personal space has none. */
const CRM: Module = {
  id: "crm",
  label: "CRM",
  icon: IconHandshake,
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

export function ModuleSwitcher() {
  const current = BY_ID[useCurrentModule()];
  const open = useOpenModule();
  const modules = useHasCrm() ? MODULES : MODULES.filter((module) => module.id !== "crm");

  const openModule = (module: Module) => {
    if (module.id !== current.id) open(module.id);
  };

  return (
    // Two buttons side by side, after Craft: the module (most of the row) and the workspace's
    // avatar at its end. 6px apart, so a finger's 44px area around the avatar's 32px button
    // stops at the module's edge; each has its own hover and pressed fill.
    <div className="flex min-w-0 items-center gap-1.5">
      <MenuTrigger>
        <SidebarItemTrigger aria-label={`Switch module, currently ${current.label}`}>
          <span className="grid size-icon shrink-0 place-items-center">
            <span className="-m-[1.5px]">
              <ModuleMark module={current} />
            </span>
          </span>
          <span className="min-w-0 truncate">{current.label}</span>
        </SidebarItemTrigger>
        <Menu
          placement="bottom start"
          popover={{
            offset: 4,
            // The row sits 8px from the window's edge: the menu keeps the same 8px.
            collisionPadding: 8,
            className: "min-w-(--anchor-width) max-w-[min(18rem,calc(100vw-16px))]",
          }}
        >
          {modules.map((module) => (
            <MenuItem
              key={module.id}
              id={module.id}
              textValue={module.label}
              onAction={() => openModule(module)}
            >
              {/* The menu's icon gap after it, which it gives only to its own marks. */}
              <ModuleMark module={module} className="me-(--me-icon)" />
              <Label name={module.label} current={module.id === current.id} />
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <WorkspaceSwitcher />
    </div>
  );
}

/** The current workspace's avatar at the module row's end, and the menu of every workspace. */
function WorkspaceSwitcher() {
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
      {/* The mark is the button: a 22px mark in a 26px box with no fill of its own, the box
          flush with the row's end, so the mark's centre sits 13px in, on the axis of the search
          field's `/`, the unread counts and the mailbox chevron below it. Hovered or open, the
          mark itself darkens a step instead of a fill appearing behind it. */}
      <Button
        intent="plain"
        size="sq-xs"
        className="*:transition-[filter] *:duration-150 *:ease-out hover:*:brightness-92 aria-expanded:*:brightness-92"
        aria-label={`Switch workspace, currently ${active.name}`}
      >
        {openWorkspace.isPending ? (
          <Loader className="size-icon text-muted-foreground" />
        ) : (
          <WorkspaceMark workspace={active} size={22} />
        )}
      </Button>
      <Menu
        placement="bottom end"
        popover={{ offset: 4, collisionPadding: 8, className: "min-w-56" }}
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
      </Menu>
    </MenuTrigger>
  );
}
