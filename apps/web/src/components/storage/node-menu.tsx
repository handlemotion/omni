import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconArrowUpRight, IconDownload, IconFolder } from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import type { StorageNode } from "@/lib/storage.ts";

/**
 * Files and folders with their context menu, as mail's rows have theirs (`inbox/row-menu.tsx`):
 * a right-click (or a long press, or Shift+F10 on the focused row or card) opens the item's own
 * actions, the ones its "⋯" shows, at the pointer. On an item that is part of a selection of
 * several, the selection's actions; off any item, the folder's own (`background`).
 */
export function NodeMenu(props: {
  nodes: StorageNode[];
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  /** What a right-click on an item of a selection of several offers, for all of them. */
  selection?: { ids: ReadonlySet<string>; menu: () => ContextMenuEntry[] } | undefined;
  /** What a right-click between the items offers: New, Upload, the view. */
  background?: (() => ContextMenuEntry[]) | undefined;
  children: ReactNode;
}) {
  const nodeAt = (from: Element) => {
    let at = from.closest("[data-key]");
    while (at) {
      const key = at.getAttribute("data-key");
      const node = props.nodes.find((n) => n.id === key);
      if (node) return node;
      at = at.parentElement?.closest("[data-key]") ?? null;
    }
    return undefined;
  };

  const entries = (target: Element) => {
    const node = nodeAt(target);
    if (!node) return props.background?.();
    const { selection } = props;
    if (selection && selection.ids.size > 1 && selection.ids.has(node.id)) {
      return selection.menu();
    }
    return props.menu(node).flatMap((item, index) => [
      item.danger && index > 0 && "separator",
      {
        icon: item.icon,
        label: item.label,
        onAction: item.onAction,
        danger: item.danger,
        disabled: item.disabled,
      },
    ]) satisfies ContextMenuEntry[];
  };

  return (
    <div
      className="flex min-h-full flex-1 flex-col"
      {...contextMenuProps(entries, (target) => {
        const node = nodeAt(target);
        return node ? `Actions for ${node.name}` : "Actions";
      })}
    >
      {props.children}
    </div>
  );
}

/**
 * Rows that are links somewhere else (Shared with me): Open, Show in folder where the row has
 * one, and Download for the member's own files.
 */
export function LinkRowsMenu(props: {
  rows: { id: string; href: string; folderHref?: string; download?: () => void }[];
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const entries = (target: Element) => {
    const key = target.closest("[data-key]")?.getAttribute("data-key");
    const row = props.rows.find((each) => each.id === key);
    if (!row) return undefined;
    const { folderHref, download } = row;
    return [
      { icon: IconArrowUpRight, label: "Open", onAction: () => void navigate({ href: row.href }) },
      !!folderHref && {
        icon: IconFolder,
        label: "Show in folder",
        onAction: () => void navigate({ href: folderHref }),
      },
      !!download && { icon: IconDownload, label: "Download", onAction: download },
    ] satisfies ContextMenuEntry[];
  };
  return (
    <div className="contents" {...contextMenuProps(entries)}>
      {props.children}
    </div>
  );
}
