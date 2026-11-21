import { useLocation, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useMemo, useRef, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
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
  home: "/$workspace/mail/inbox" | "/$workspace/files/my" | "/$workspace/crm/companies";
  fill: string;
}

const MAIL: Module = {
  id: "mail",
  label: "Mail",
  icon: IconMailFilled,
  home: "/$workspace/mail/inbox",
  fill: "bg-module-mail",
};
const DRIVE: Module = {
  id: "files",
  label: "Drive",
  icon: IconFolderFilled,
  home: "/$workspace/files/my",
  fill: "bg-module-drive",
};
const CRM: Module = {
  id: "crm",
  label: "CRM",
  icon: IconHandshakeFilled,
  home: "/$workspace/crm/companies",
  fill: "bg-module-crm",
};
const MODULES = [MAIL, DRIVE, CRM];
const MODULES_WITHOUT_CRM = [MAIL, DRIVE];
const BY_ID = { mail: MAIL, files: DRIVE, crm: CRM } as const;

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** The module a path belongs to: Drive's and the CRM's own paths, else Mail (every other shell
 *  route is mail's). Paths are `/<workspace>/<module>/…`. */
export const moduleOf: (pathname: string) => ModuleId = (pathname) => {
  const place = `/${pathname.split("/").slice(2).join("/")}`;
  if (under(place, "/files")) return "files";
  if (under(place, "/crm")) return "crm";
  return "mail";
};

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
      <Icon className="size-3 transform-gpu text-module-foreground" />
    </span>
  );
}

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

function Label({ name, current }: { name: string; current: boolean }) {
  return (
    <MenuLabel className="col-[2/-1] flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {current && <IconCircleCheckFilled className="size-4 shrink-0 text-primary" />}
    </MenuLabel>
  );
}

/**
 * `open(id)` goes to a module's home, keeping the workspace and the mailbox shown in mail: it
 * rides along both ways, so coming back to Mail shows the same one. The switcher, the sidebar's
 * pages and `g f` all open modules through this; the sidebar's pages glide to follow.
 */
export function useOpenModule() {
  const router = useRouter();
  const workspace = useWorkspaceSlug();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  return (id: ModuleId) =>
    router.navigate({
      to: BY_ID[id].home,
      params: { workspace },
      search: mailbox ? { mailbox } : {},
    });
}

/** The modules in their sidebar order, the CRM only where the workspace has it. */
export function useModules() {
  const hasCrm = useHasCrm();
  return hasCrm ? MODULES : MODULES_WITHOUT_CRM;
}

/**
 * The sidebar's foot, as on iOS: the module on screen in a pill, between a chevron each way to its
 * neighbour (disabled where there is none). The pill's contents ride the sidebar's pages
 * (`--module-at`, from `ModulePager`), so a swipe moves both under the fingers.
 */
export function ModuleSwitcher() {
  const current = BY_ID[useCurrentModule()];
  const open = useOpenModule();
  const modules = useModules();
  const index = Math.max(0, modules.indexOf(current));
  const go = (by: 1 | -1) => {
    const module = modules[index + by];
    if (module) void open(module.id);
  };

  return (
    <div
      role="group"
      aria-label="Modules"
      data-module={current.id}
      className="flex h-8 items-center justify-center gap-1"
    >
      <Step module={modules[index - 1]} direction="previous" onPress={() => go(-1)} />
      <div className="relative grid h-8 min-w-0 overflow-hidden rounded-full border border-border">
        <span className="sr-only">{current.label}</span>
        {modules.map((module) => (
          <Face key={module.id} module={module} className="invisible col-start-1 row-start-1" />
        ))}
        <div
          aria-hidden
          className="absolute inset-0 flex"
          style={{ translate: `calc(var(--module-at, ${index}) * -100%) 0` }}
        >
          {modules.map((module) => (
            <Face key={module.id} module={module} className="w-full flex-none" />
          ))}
        </div>
      </div>
      <Step module={modules[index + 1]} direction="next" onPress={() => go(1)} />
    </div>
  );
}

function Face({ module, className }: { module: Module; className?: string }) {
  return (
    <span aria-hidden className={cn("flex min-w-0 items-center gap-2 ps-1.5 pe-3", className)}>
      <ModuleMark module={module} className="size-5 rounded-[6px]" />
      <span className="truncate text-sm font-medium">{module.label}</span>
    </span>
  );
}

function Step(props: {
  module: Module | undefined;
  direction: "previous" | "next";
  onPress: () => void;
}) {
  const Icon = props.direction === "previous" ? IconChevronLeft : IconChevronRight;
  return (
    <Button
      intent="plain"
      size="sq-xs"
      isCircle
      isDisabled={!props.module}
      aria-label={props.module ? `Go to ${props.module.label}` : `No ${props.direction} module`}
      onPress={props.onPress}
    >
      <Icon />
    </Button>
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
        <SidebarItemTrigger
          aria-label={`Switch workspace, currently ${label(active)}`}
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
            offset: workspacesOnly ? 2 : 4,
            collisionPadding: 8,
            className: "w-60 min-w-(--anchor-width) max-w-[calc(100vw-16px)]",
          }}
        >
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              id={workspace.id}
              textValue={label(workspace)}
              onAction={() => choose(workspace)}
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
