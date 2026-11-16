import { Fragment, useState, type ReactNode, type SyntheticEvent } from "react";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { ContextMenuTrigger, Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import type { StorageNode } from "@/lib/storage.ts";

/**
 * Files and folders with their context menu, as mail's rows have theirs (`inbox/row-menu.tsx`):
 * a right-click (or a long press, or Shift+F10 on the focused row or card) opens the item's own
 * actions, the ones its "⋯" shows, at the pointer. Off an item, the browser's own menu shows.
 */
export function NodeMenu(props: {
  nodes: StorageNode[];
  menu: (node: StorageNode) => SettingsRowMenuItem[];
  children: ReactNode;
}) {
  const [target, setTarget] = useState<string>();
  const node = props.nodes.find((n) => n.id === target);
  const items = node ? props.menu(node) : [];

  const pick = (event: SyntheticEvent, from: Element | null) => {
    // The nearest key that is an item's: a table's cells carry keys of their own.
    let at = from?.closest("[data-key]");
    while (at && !props.nodes.some((n) => n.id === at?.getAttribute("data-key"))) {
      at = at.parentElement?.closest("[data-key]");
    }
    const key = at?.getAttribute("data-key");
    if (key) setTarget(key);
    // Not on an item: nothing to act on, so the menu stays shut.
    else event.stopPropagation();
  };

  return (
    <ContextMenuTrigger>
      <div
        onContextMenuCapture={(event) => pick(event, event.target as Element)}
        onKeyDownCapture={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            pick(event, document.activeElement);
          }
        }}
      >
        {props.children}
      </div>
      {/* At the pointer, 2px off it, so the first item is not under the click. */}
      <Menu aria-label={node ? `Actions for ${node.name}` : "Actions"} popover={{ offset: 2 }}>
        {items.map(({ icon: Icon, ...item }, index) => (
          <Fragment key={item.label}>
            {/* What can't be taken back sits apart, as mail's Move to trash does. */}
            {item.danger && index > 0 && <MenuSeparator />}
            <MenuItem
              textValue={item.label}
              intent={item.danger ? "danger" : undefined}
              isDisabled={item.disabled}
              onAction={item.onAction}
            >
              <Icon data-slot="icon" />
              <MenuLabel>{item.label}</MenuLabel>
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
    </ContextMenuTrigger>
  );
}
