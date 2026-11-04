import type { Key } from "react-aria-components/Collection";
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { SettingsRow, type SettingsRowIcon } from "./settings-row";

export interface SettingsSelectOption<Value extends string> {
  disabled?: boolean;
  label: string;
  value: Value;
}

/**
 * The select every settings row uses: as wide as its choice (a long one ends in an ellipsis; the
 * open list shows it in full), never wider than an input.
 */
export const settingsSelectClassName = "w-auto min-w-28 max-w-56";

/** One choice from a short list. */
export function SettingsSelectRow<Value extends string>({
  disabled,
  id,
  label,
  onValueChange,
  options,
  placeholder,
  trailing,
  value,
  ...text
}: {
  badge?: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  icon?: SettingsRowIcon;
  avatar?: ReactNode;
  id: string;
  label: string;
  onValueChange: (value: Value) => void;
  options: readonly SettingsSelectOption<Value>[];
  placeholder?: string;
  /** A control after the select, such as the row's menu. */
  trailing?: ReactNode;
  value: Value | null;
}) {
  return (
    <SettingsRow
      {...text}
      label={label}
      control={
        <>
          <Select
            aria-label={label}
            className={settingsSelectClassName}
            id={id}
            isDisabled={disabled}
            placeholder={placeholder}
            value={value}
            onChange={(next: Key | null) => {
              const option = options.find((candidate) => candidate.value === next);
              if (option) onValueChange(option.value);
            }}
          >
            <SelectTrigger />
            <SelectContent items={options} popover={{ placement: "bottom end" }}>
              {(option) => (
                <SelectItem id={option.value} textValue={option.label} isDisabled={option.disabled}>
                  {option.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          {trailing}
        </>
      }
    />
  );
}
