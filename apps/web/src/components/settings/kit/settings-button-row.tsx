import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow, type SettingsRowIcon } from "./settings-row";

/**
 * How the row's action reads: `secondary` for ordinary actions, `primary` for the one action the
 * page exists for, `danger` for ones that delete or can't be undone (say what happens on it).
 */
export type SettingsButtonTone = "secondary" | "primary" | "danger";

const INTENT = { secondary: "outline", primary: "primary", danger: "danger" } as const;

/** A row whose control is one action. */
export function SettingsButtonRow({
  actionIcon,
  actionLabel,
  disabled,
  loading,
  onAction,
  tone = "secondary",
  ...text
}: {
  actionIcon?: ReactNode;
  actionLabel: string;
  avatar?: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  footer?: ReactNode;
  icon?: SettingsRowIcon;
  label: ReactNode;
  loading?: boolean;
  onAction: () => void;
  tone?: SettingsButtonTone;
}) {
  return (
    <SettingsRow
      {...text}
      control={
        <Button intent={INTENT[tone]} isDisabled={disabled} isPending={loading} onPress={onAction}>
          {actionIcon}
          {actionLabel}
        </Button>
      }
    />
  );
}
