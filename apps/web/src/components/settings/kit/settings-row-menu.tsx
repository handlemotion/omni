import { IconEllipsis } from "@/components/icons/central";
import { useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";

export interface SettingsRowMenuItem {
  danger?: boolean;
  disabled?: boolean;
  /** Required: every menu item leads with an icon (DESIGN.md, "Menus"). */
  icon: ComponentType<{ className?: string; "data-slot"?: string }>;
  label: string;
  onAction: () => void;
}

/** The "⋯" control for a listed item's secondary actions (a member, a passkey, an account). */
export function SettingsRowMenu({
  disabled,
  items,
  label,
  lazy = false,
}: {
  disabled?: boolean;
  items: readonly SettingsRowMenuItem[];
  /** Names the item: "Actions for Passkey on Mac". */
  label: string;
  /**
   * Mounts the menu the first time its button is pointed at, focused or pressed, always before
   * it can open. For long lists, where every row's closed menu was a third of the time it took
   * to scroll a row into view.
   */
  lazy?: boolean;
}) {
  const [armed, setArmed] = useState(!lazy);
  const arm = armed ? undefined : () => setArmed(true);
  return (
    <MenuTrigger>
      <Button
        intent="plain"
        size="sq-xs"
        aria-label={label}
        isDisabled={disabled}
        onPointerEnter={arm}
        onPointerDown={arm}
        onFocus={arm}
      >
        <IconEllipsis />
      </Button>
      {armed && (
        <Menu placement="bottom end">
          {items.map(({ icon: Icon, ...item }) => (
            <MenuItem
              key={item.label}
              textValue={item.label}
              intent={item.danger ? "danger" : undefined}
              isDisabled={item.disabled}
              onAction={item.onAction}
            >
              <Icon data-slot="icon" />
              <MenuLabel>{item.label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      )}
    </MenuTrigger>
  );
}
