import { useLocation, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
  IconFolder,
  IconFolderFilled,
  IconHandshake,
  IconHandshakeFilled,
  IconMail,
  IconMailFilled,
  IconSettings,
  IconSettingsFilled,
} from "@/components/icons/central";
import {
  Sidebar,
  SidebarContent,
  SidebarExpanded,
  SidebarItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { isSettingsPath, useOpenSettings } from "@/hooks/use-settings.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";
import { useCurrentModule, useModules, type ModuleId } from "./module-switcher";
import { UpdateRow, UpdateTile } from "./update-row";

type Icon = ComponentType<{ className?: string }>;

const ICONS: Record<ModuleId, { idle: Icon; current: Icon }> = {
  mail: { idle: IconMail, current: IconMailFilled },
  files: { idle: IconFolder, current: IconFolderFilled },
  crm: { idle: IconHandshake, current: IconHandshakeFilled },
};

const PATHS: Record<ModuleId, string> = {
  mail: "mail/inbox",
  files: "files/my",
  crm: "crm/companies",
};

const PEEK_LEAVE_MS = 200;
let peeking = false;
let leaving = 0;
const listeners = new Set<() => void>();
const setPeeking = (next: boolean) => {
  window.clearTimeout(leaving);
  if (peeking === next) return;
  peeking = next;
  for (const listener of listeners) listener();
};

/** The closed sidebar's preview: shown while the pointer rests on the toggle or the panel. */
export const railPeek = {
  enter: () => setPeeking(true),
  leave: () => {
    window.clearTimeout(leaving);
    leaving = window.setTimeout(() => setPeeking(false), PEEK_LEAVE_MS);
  },
  stay: () => window.clearTimeout(leaving),
  end: () => setPeeking(false),
};

function useRailPeek() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => peeking,
  );
}

const TILE_SHAPE = "size-8 justify-center rounded-[9px] px-0 *:[svg]:size-4.5";
const TILE = `${TILE_SHAPE} hover:bg-secondary`;

/**
 * The modules as a column of icon tiles on the window's grey, the current one on a
 * white tile with its filled glyph; settings at its foot. Its first tile lines up with the nav
 * panel's header row. Closing the sidebar hides the nav panel; the rail stays.
 */
export function RailSidebar({ title, children }: { title: string; children: ReactNode }) {
  const { open } = useSidebar();
  const peek = useRailPeek() && !open;
  useEffect(() => {
    if (open) railPeek.end();
  }, [open]);
  const panel = (
    <>
      <div className="-mb-2 flex h-11 items-center px-2 text-md">{title}</div>
      {children}
      <div className="mt-auto pb-3 empty:hidden">
        <UpdateRow />
      </div>
    </>
  );
  return (
    <Sidebar
      collapsible="none"
      closeButton={false}
      data-state={open ? "expanded" : "collapsed"}
      className={cn("peer shrink-0 bg-transparent", !open && "w-14.5")}
    >
      <div className="flex min-h-0 flex-1">
        <ModuleRail />
        {open ? (
          <SidebarContent className={PANEL}>{panel}</SidebarContent>
        ) : (
          <div
            inert={!peek}
            aria-hidden={!peek || undefined}
            onPointerEnter={railPeek.stay}
            onPointerLeave={railPeek.leave}
            className={cn(
              "fixed start-14.5 top-12 bottom-0 z-30 flex w-[calc(var(--sidebar-width)-58px)] rounded-tl-xl shadow-overlay",
              "transition-[translate,opacity,visibility] duration-200 ease-(--ease-out) motion-reduce:transition-[opacity,visibility]",
              peek
                ? "visible translate-x-0 opacity-100"
                : "invisible -translate-x-3 opacity-0 motion-reduce:translate-x-0",
            )}
          >
            <SidebarExpanded>
              <SidebarContent className={cn(PANEL, "mt-0 w-full")}>{panel}</SidebarContent>
            </SidebarExpanded>
          </div>
        )}
      </div>
    </Sidebar>
  );
}

const PANEL =
  "mt-12 rounded-tl-xl border-s border-t border-e border-sidebar-border bg-background px-3 pt-0.5 *:shrink-0";

function ModuleRail() {
  const { open } = useSidebar();
  const modules = useModules();
  const inSettings = isSettingsPath(useLocation().pathname);
  const module = useCurrentModule();
  const current = inSettings ? null : module;
  const workspace = useWorkspaceSlug();
  const openSettings = useOpenSettings();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const keep = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : "";

  return (
    <nav
      aria-label="Modules"
      className="flex w-14.5 shrink-0 flex-col items-center gap-1.75 pt-[57px] pb-3.25"
    >
      {modules.map((module) => {
        const isCurrent = module.id === current;
        const Icon = isCurrent ? ICONS[module.id].current : ICONS[module.id].idle;
        return (
          <RailTip key={module.id} label={module.label}>
            <SidebarItem
              href={`/${encodeURIComponent(workspace)}/${PATHS[module.id]}${keep}`}
              isCurrent={isCurrent}
              aria-label={module.label}
              className={cn(TILE, isCurrent && "bg-background hover:bg-background")}
            >
              <Icon />
            </SidebarItem>
          </RailTip>
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1.75">
        {!open && <UpdateTile className={TILE_SHAPE} />}
        <RailTip label="Settings">
          <SidebarItem
            aria-label="Settings"
            isCurrent={inSettings}
            onPress={() => openSettings("general")}
            className={cn(TILE, inSettings && "bg-background hover:bg-background")}
          >
            {inSettings ? <IconSettingsFilled /> : <IconSettings />}
          </SidebarItem>
        </RailTip>
      </div>
    </nav>
  );
}

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipTrigger>
      {children}
      <Tooltip placement="right">{label}</Tooltip>
    </TooltipTrigger>
  );
}
