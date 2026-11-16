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
import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useMemo, useRef, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  IconChevronsUpDown,
  IconCircleCheckFilled,
  IconConnections,
  IconFolderFilled,
  IconHandshakeFilled,
  IconLogOut,
  IconMailFilled,
  IconPlus,
  IconSettings,
  IconUpgrade,
  IconUserAdd,
  IconUserRound,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarItemTrigger } from "@/components/ui/sidebar";
import { appToast } from "@/components/ui/toast";
import { isManager } from "@/components/settings/workspace-pages";
import { useBilling } from "@/hooks/use-billing.ts";
import { useHasCrm } from "@/hooks/use-crm.ts";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useMember, useSignOut } from "@/hooks/use-session.ts";
import { useOpenSettings } from "@/hooks/use-settings.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";
import { useOpenWorkspace, useWorkspaceSlug, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace } from "@/lib/types.ts";

export type ModuleId = "mail" | "files" | "crm";

interface Module {
  id: ModuleId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Where switching to the module lands. */
  home: "/$workspace/mail/inbox" | "/$workspace/files/my" | "/$workspace/crm/companies";
  /** Its identity colour, as a fill. */
  fill: string;
}

const MAIL: Module = {
  id: "mail",
  label: "Mail",
  icon: IconMailFilled,
  home: "/$workspace/mail/inbox",
  fill: "bg-module-mail",
};
/** Storage (ADR 0034), called Drive; its paths stay `/<workspace>/files/*`. */
const DRIVE: Module = {
  id: "files",
  label: "Drive",
  icon: IconFolderFilled,
  home: "/$workspace/files/my",
  fill: "bg-module-drive",
};
/** The CRM (ADR 0036, ADR 0039): a company workspace's only; a Personal space has none. */
const CRM: Module = {
  id: "crm",
  label: "CRM",
  icon: IconHandshakeFilled,
  home: "/$workspace/crm/companies",
  fill: "bg-module-crm",
};
const MODULES = [MAIL, DRIVE, CRM];
const BY_ID = { mail: MAIL, files: DRIVE, crm: CRM } as const;

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** The module a path belongs to: Drive's and the CRM's own paths, else Mail (every other shell
 *  route is mail's). Paths are `/<workspace>/<module>/…` (ADR 0043). */
export function moduleOf(pathname: string): ModuleId {
  const place = `/${pathname.split("/").slice(2).join("/")}`;
  if (under(place, "/files")) return "files";
  if (under(place, "/crm")) return "crm";
  return "mail";
}

/** Where a module's paths start in a workspace: Back from settings lands here after a switch. */
export function moduleHome(pathname: string, workspace: string) {
  return BY_ID[moduleOf(pathname)].home.replace("$workspace", encodeURIComponent(workspace));
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

/**
 * The switcher's mark: 18px over the nav icons' 15px box (the margin centres it on their axis),
 * or alone a size up, 22px, in the title bar; a loader while a workspace opens.
 */
function TriggerMark(props: { workspace: Workspace; busy: boolean; large: boolean }) {
  if (props.large && !props.busy) return <WorkspaceMark workspace={props.workspace} size={22} />;
  return (
    <span className="grid size-icon shrink-0 place-items-center">
      {props.busy ? (
        <Loader className="size-icon text-muted-foreground" />
      ) : (
        <span className="-m-[1.5px]">
          <WorkspaceMark workspace={props.workspace} size={18} />
        </span>
      )}
    </span>
  );
}

/** A row's name, with the check on the current one riding inside the label so it sits on the
 *  name's line, 6px in from the row's end (as the settings workspace chooser does). */
function Label({ name, current }: { name: string; current: boolean }) {
  return (
    // To the item's end (past the grid's empty columns), so the check sits at the far edge.
    <MenuLabel className="col-[2/-1] flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {current && <IconCircleCheckFilled className="size-4 shrink-0 text-primary" />}
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
  const workspace = useWorkspaceSlug();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return (id: ModuleId) => {
    const module = BY_ID[id];
    void router.navigate({
      to: module.home,
      params: { workspace },
      search: mailbox ? { mailbox } : {},
    });
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
              // 6px in, as above and below the 18px mark; the check 6px from the end to match.
              className="ps-1.5 pe-1.5"
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

/**
 * A workspace as the person reads it: a company by its name; their Personal space as their own
 * ("Rodrigo's Workspace"), from the first word of their name.
 */
export function workspaceLabel(workspace: Workspace, userName: string | null | undefined) {
  if (workspace.kind !== "personal") return workspace.name;
  const first = userName?.trim().split(/\s+/)[0];
  return first ? `${first}'s Workspace` : "Personal Workspace";
}

/**
 * The sidebar's top row: the workspace's mark and name, hugging them (no chevron), with `end` (the
 * bell) at the row's far end. Its menu, the sidebar's width: every workspace (the current one
 * checked) and New workspace; account, workspace and connection settings; a company's Invite
 * members and Upgrade for those who manage it; Log out. With `workspacesOnly` (settings' nav), only
 * the workspaces and New workspace, and `onChoose` decides what choosing one does.
 */
export function WorkspaceSwitcher({
  end,
  workspacesOnly = false,
  iconOnly = false,
  onChoose,
  pending = false,
}: {
  end?: ReactNode;
  workspacesOnly?: boolean;
  /** Its mark alone, as the desktop app's title bar draws it; the menu is the same. */
  iconOnly?: boolean;
  onChoose?: (workspace: Workspace) => void;
  pending?: boolean;
}) {
  const { member, user } = useMember();
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const openWorkspace = useOpenWorkspace();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const canCreate = useOnboarding().data?.canCreateOrganization === true;
  // Only for those who'd see Billing: a company's owners and admins.
  const active = workspaces.find((w) => w.id === member.orgId);
  const team = !!active && active.kind !== "personal" && isManager(member.role);
  const row = useRef<HTMLDivElement>(null);
  const rowBox = useMemo(
    () => ({ getBoundingClientRect: () => row.current?.getBoundingClientRect() ?? new DOMRect() }),
    [],
  );
  if (!active) return null;
  const label = (workspace: Workspace) => workspaceLabel(workspace, user.name);

  const choose = (workspace: Workspace) => {
    if (onChoose) return onChoose(workspace);
    if (workspace.id === member.orgId) return;
    openWorkspace.mutate(workspace, {
      onError: () => appToast.error("The workspace could not be opened."),
    });
  };

  return (
    <div ref={row} className="flex min-w-0 items-center justify-between gap-1">
      <MenuTrigger>
        {/* The mark in the nav icons' 15px box and the name 10px after it, as the rows under it;
            the trigger hugs them. */}
        <SidebarItemTrigger
          aria-label={`Switch workspace, currently ${label(active)}`}
          // 9px after the name against the mark's 6.5px from the start (optical, measured): the
          // text's soft end needs a little more room than the mark's hard edge to look even. In
          // settings it is a full row with the mailbox switcher's chevron, as a chooser.
          // In the desktop title bar, the mark in the same 28px square as the arrows beside it.
          className={
            iconOnly
              ? "size-7 shrink-0 justify-center px-0"
              : workspacesOnly
                ? undefined
                : "w-auto max-w-full shrink pe-2.25"
          }
        >
          <TriggerMark
            workspace={active}
            busy={openWorkspace.isPending || pending}
            large={iconOnly}
          />
          {!iconOnly && <span className="min-w-0 truncate">{label(active)}</span>}
          {workspacesOnly && (
            <IconChevronsUpDown className="ms-auto -me-0.75 size-3.5 shrink-0 text-subtle-foreground group-hover/sidebar-item:text-foreground group-aria-expanded/sidebar-item:text-foreground" />
          )}
        </SidebarItemTrigger>
        <Menu
          placement="bottom start"
          popover={{
            anchor: rowBox,
            // 2px in settings, on the next row's top edge: that row can be the current page's grey
            // fill, and any wider gap shows its edge as a stripe (measured).
            offset: workspacesOnly ? 2 : 4,
            collisionPadding: 8,
            // The sidebar's width: a touch past the links, never narrower than the row.
            className: "w-60 min-w-(--anchor-width) max-w-[calc(100vw-16px)]",
          }}
        >
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              id={workspace.id}
              textValue={label(workspace)}
              onAction={() => choose(workspace)}
              // 6px in, as above and below the 20px mark: balanced (the items' 10px is for 14px
              // icons). The name runs to the end, the check 6px from it, as the mark from the start.
              className="ps-1.5 pe-1.5"
            >
              <WorkspaceMark workspace={workspace} size={20} />
              <Label name={label(workspace)} current={workspace.id === member.orgId} />
            </MenuItem>
          ))}
          {canCreate && (
            <MenuItem
              id="new"
              textValue="New workspace"
              onAction={() => void navigate({ to: "/onboarding" })}
            >
              <IconPlus data-slot="icon" />
              <MenuLabel>New workspace</MenuLabel>
            </MenuItem>
          )}
          {!workspacesOnly && <SettingsItems team={team} onLogOut={() => signOut.mutate()} />}
        </Menu>
      </MenuTrigger>
      {end}
    </div>
  );
}

/** The workspace menu's way into settings, a company's Invite and Upgrade, and Log out. */
function SettingsItems(props: { team: boolean; onLogOut: () => void }) {
  const { team } = props;
  const billing = useBilling({ enabled: team }).data;
  const plan = billing?.enabled ? billing : null;
  const upgrade =
    team &&
    !!plan?.canManage &&
    (plan.readOnly || !plan.subscription || plan.subscription.status === "trialing");
  const openSettings = useOpenSettings();
  return (
    <>
      <MenuSeparator />
      <MenuItem id="account" textValue="Account settings" onAction={() => openSettings("profile")}>
        <IconUserRound data-slot="icon" />
        <MenuLabel>Account settings</MenuLabel>
      </MenuItem>
      <MenuItem
        id="workspace"
        textValue="Workspace settings"
        aria-keyshortcuts={ariaKeyShortcuts("settings")}
        onAction={() => openSettings("general")}
      >
        <IconSettings data-slot="icon" />
        <MenuLabel>Workspace settings</MenuLabel>
      </MenuItem>
      <MenuItem id="connections" textValue="Connections" onAction={() => openSettings("accounts")}>
        <IconConnections data-slot="icon" />
        <MenuLabel>Connections</MenuLabel>
      </MenuItem>
      {(team || upgrade) && <MenuSeparator />}
      {team && (
        <MenuItem id="invite" textValue="Invite members" onAction={() => openSettings("people")}>
          <IconUserAdd data-slot="icon" />
          <MenuLabel>Invite members</MenuLabel>
        </MenuItem>
      )}
      {upgrade && (
        <MenuItem id="upgrade" textValue="Upgrade" onAction={() => openSettings("billing")}>
          <IconUpgrade data-slot="icon" />
          <MenuLabel>Upgrade</MenuLabel>
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem id="log-out" textValue="Log out" onAction={props.onLogOut}>
        <IconLogOut data-slot="icon" />
        <MenuLabel>Log out</MenuLabel>
      </MenuItem>
    </>
  );
}
