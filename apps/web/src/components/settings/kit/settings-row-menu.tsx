import { EllipsisHorizontalIcon } from "@heroicons/react/16/solid";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";

export interface SettingsRowMenuItem {
  danger?: boolean;
  disabled?: boolean;
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
        <EllipsisHorizontalIcon />
      </Button>
      <Menu placement="bottom end">
        {items.map((item) => (
          <MenuItem
            key={item.label}
            textValue={item.label}
            intent={item.danger ? "danger" : undefined}
            isDisabled={item.disabled}
            onAction={item.onAction}
          >
            <MenuLabel>{item.label}</MenuLabel>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
