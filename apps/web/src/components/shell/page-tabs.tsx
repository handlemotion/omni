import type { Workspace } from "@omni/client";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { IconCopy, IconPlus, IconSettings, IconX } from "@/components/icons/central";
import {
  IconCalendarMark,
  IconCrmMark,
  IconDriveMark,
  IconMailMark,
  IconMeetingsMark,
} from "@/components/icons/module-marks";
import { Button } from "@/components/ui/button";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { usePageTabsStrip } from "@/hooks/use-page-tabs.ts";
import { useWorkspaceSlug, useWorkspaces } from "@/hooks/use-workspaces.ts";
import {
  PAGE_TABS_MAX,
  tabModule,
  tabWorkspace,
  type PageTab,
  type TabModule,
} from "@/lib/page-tabs.ts";
import { WorkspaceMark } from "./module-switcher";

const MARKS: Record<TabModule, ComponentType<{ className?: string }>> = {
  mail: IconMailMark,
  files: IconDriveMark,
  crm: IconCrmMark,
  calendar: IconCalendarMark,
  meetings: IconMeetingsMark,
  settings: IconSettings,
};

/**
 * The open pages as tabs, centred on the top rail, from every workspace: each shows its module's
 * mark and the page's name, and a tab of another workspace than the one on screen ends with
 * that workspace's mark. Pressing a tab shows its page (switching workspace when it is another's);
 * New tab opens this workspace's Inbox.
 */
export function PageTabs() {
  const workspace = useWorkspaceSlug();
  const tabs = usePageTabsStrip(workspace);
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [dragId, setDragId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const activeId = tabs.state?.activeId;
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  if (!tabs.state) return null;
  const { state } = tabs;
  const closable = state.tabs.length > 1;

  const menu = contextMenuProps((target) => {
    const id = target.closest("[data-tab-id]")?.getAttribute("data-tab-id");
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return null;
    return [
      {
        icon: IconCopy,
        label: "Duplicate tab",
        disabled: tabs.full,
        onAction: () => tabs.duplicate(tab),
      },
      "separator",
      { icon: IconX, label: "Close tab", disabled: !closable, onAction: () => tabs.close(tab.id) },
      {
        icon: IconX,
        label: "Close other tabs",
        disabled: !closable,
        onAction: () => tabs.closeOthers(tab.id),
      },
    ] satisfies ContextMenuEntry[];
  }, "Tab actions");

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        {...menu}
        ref={list}
        role="tablist"
        aria-label="Open pages"
        className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {state.tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            tab={tab}
            title={tabs.title(tab.href)}
            active={tab.id === state.activeId}
            closable={closable}
            dragging={dragId === tab.id}
            other={otherWorkspace(workspaces, tab.href, workspace)}
            onActivate={() => tabs.activate(tab.id)}
            onClose={() => tabs.close(tab.id)}
            onDragStart={() => setDragId(tab.id)}
            onDragEnd={() => setDragId(null)}
            onDrop={() => {
              if (dragId) tabs.move(dragId, index);
              setDragId(null);
            }}
          />
        ))}
      </div>
      <TooltipTrigger delay={400}>
        <Button
          intent="ghost"
          size="sq-sm"
          aria-label="New tab"
          isDisabled={tabs.full}
          onPress={tabs.newTab}
          className="disabled:opacity-40"
        >
          <IconPlus />
        </Button>
        <Tooltip>
          {tabs.full ? `Close a tab to open another (up to ${PAGE_TABS_MAX})` : "New tab"}
        </Tooltip>
      </TooltipTrigger>
    </div>
  );
}

function otherWorkspace(workspaces: Workspace[], href: string, current: string) {
  const slug = tabWorkspace(href);
  if (slug === current) return undefined;
  return workspaces.find((w) => w.slug === slug);
}

function Tab(props: {
  tab: PageTab;
  title: string;
  active: boolean;
  closable: boolean;
  dragging: boolean;
  other: Workspace | undefined;
  onActivate: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const router = useRouter();
  const Mark = MARKS[tabModule(props.tab.href)];
  const name = props.other ? `${props.title}, ${props.other.name}` : props.title;
  return (
    <div
      role="tab"
      aria-selected={props.active}
      aria-label={name}
      title={name}
      data-tab-id={props.tab.id}
      tabIndex={props.active ? 0 : -1}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest("button")) return;
        props.onActivate();
      }}
      onPointerEnter={
        props.active
          ? undefined
          : () =>
              void router
                .preloadRoute({ to: props.tab.href.split(/[?#]/)[0]! })
                .catch(() => undefined)
      }
      onAuxClick={(event) => {
        if (event.button !== 1 || !props.closable) return;
        event.preventDefault();
        props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onActivate();
          return;
        }
        const sibling =
          event.key === "ArrowRight"
            ? event.currentTarget.nextElementSibling
            : event.key === "ArrowLeft"
              ? event.currentTarget.previousElementSibling
              : null;
        if (sibling instanceof HTMLElement && sibling.dataset.tabId) {
          event.preventDefault();
          sibling.focus();
          sibling.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        }
      }}
      className={cn(
        "group/tab relative flex h-8 max-w-52 min-w-0 shrink-0 cursor-default items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap outline-none select-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-background text-foreground ring-1 ring-border ring-inset"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        props.dragging && "opacity-50",
      )}
    >
      <span className="relative grid size-4 shrink-0 place-items-center">
        <Mark className={cn("size-4", props.closable && "group-hover/tab:invisible")} />
        {props.closable && (
          <Button
            intent="plain"
            size="sq-2xs"
            aria-label={`Close ${props.title}`}
            onPress={props.onClose}
            className="invisible absolute -start-0.5 -top-0.5 text-muted-foreground mix-blend-multiply [--btn-overlay:var(--color-secondary)] group-hover/tab:visible"
          >
            <IconX />
          </Button>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      {props.other && (
        <span className="flex shrink-0">
          <WorkspaceMark workspace={props.other} size={16} />
        </span>
      )}
    </div>
  );
}
