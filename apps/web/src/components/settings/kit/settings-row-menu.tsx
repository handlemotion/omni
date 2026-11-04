import { IconDotGrid1x3Horizontal } from "central-icons-outlined/IconDotGrid1x3Horizontal";
import type { ComponentType } from "react";
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
}: {
  disabled?: boolean;
  items: readonly SettingsRowMenuItem[];
  /** Names the item: "Actions for Passkey on Mac". */
  label: string;
}) {
  return (
    <MenuTrigger>
      <Button intent="plain" size="sq-xs" aria-label={label} isDisabled={disabled}>
        <IconDotGrid1x3Horizontal />
      </Button>
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
    </MenuTrigger>
  );
}
