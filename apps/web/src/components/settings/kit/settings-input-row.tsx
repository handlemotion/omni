import type { ReactNode } from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { SettingsRow, type SettingsRowIcon } from "./settings-row";

/** Every settings input is this one width; longer values scroll inside it. */
export const settingsInputClassName = "w-56 max-w-full";

/** A short text value edited in place; `trailing` holds the action that commits it, if any. */
export function SettingsInputRow({
  badge,
  hint,
  description,
  icon,
  id,
  label,
  trailing,
  ...input
}: Omit<InputProps, "className" | "id" | "size"> & {
  badge?: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  icon?: SettingsRowIcon;
  id: string;
  label: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <SettingsRow
      badge={badge}
      hint={hint}
      description={description}
      icon={icon}
      label={label}
      htmlFor={id}
      control={
        <>
          <span className={settingsInputClassName}>
            <Input {...input} id={id} />
          </span>
          {trailing}
        </>
      }
    />
  );
}
