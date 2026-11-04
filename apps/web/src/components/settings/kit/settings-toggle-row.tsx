import type { ReactNode } from "react";
import { Switch, SwitchField } from "@/components/ui/switch";
import { SettingsRow, type SettingsRowIcon } from "./settings-row";

/** An on/off setting. The whole label toggles the switch. */
export function SettingsToggleRow({
  checked,
  disabled,
  id,
  onCheckedChange,
  trailing,
  ...text
}: {
  avatar?: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  description?: ReactNode;
  disabled?: boolean;
  footer?: ReactNode;
  icon?: SettingsRowIcon;
  id: string;
  label: ReactNode;
  onCheckedChange: (checked: boolean) => void;
  /** A control placed before the switch. */
  trailing?: ReactNode;
}) {
  return (
    <SettingsRow
      {...text}
      htmlFor={id}
      control={
        <>
          {trailing}
          <SwitchField
            id={id}
            isSelected={checked}
            isDisabled={disabled}
            onChange={onCheckedChange}
          >
            <Switch />
          </SwitchField>
        </>
      }
    />
  );
}
