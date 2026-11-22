import { useLocation, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { IconSettings, IconSettingsFilled } from "@/components/icons/central";
import { IconCrmMark, IconDriveMark, IconMailMark } from "@/components/icons/module-marks";
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

const MARKS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  mail: IconMailMark,
  files: IconDriveMark,
  crm: IconCrmMark,
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
const MODULE_TILE = "size-8 justify-center rounded-[9px] px-0 *:[svg]:size-5 hover:bg-secondary";

/**
 * The modules as a column of tiles on the window's grey, each with its own coloured mark, the
 * current one on a white tile; settings at its foot. Its first tile lines up with the nav
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
  const inSettings = useLocation({
    select: (location) => isSettingsPath(location.pathname),
  });
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
        const Mark = MARKS[module.id];
        return (
          <RailTip key={module.id} label={module.label}>
            <SidebarItem
              href={`/${encodeURIComponent(workspace)}/${PATHS[module.id]}${keep}`}
              isCurrent={isCurrent}
              aria-label={module.label}
              className={cn(MODULE_TILE, isCurrent && "bg-background hover:bg-background")}
            >
              <Mark />
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
