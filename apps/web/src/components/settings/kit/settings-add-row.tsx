import { PlusIcon } from "@heroicons/react/16/solid";
import { cn } from "cn";
import { Button } from "react-aria-components/Button";
import {
  settingsRowClassName,
  settingsRowInteractiveClassName,
  settingsRowTextEndClassName,
} from "./settings-row";

/** A row that adds something to its group: "+ Add a passkey". */
export function SettingsAddRow({
  disabled,
  label,
  loading,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      className={cn(
        settingsRowClassName,
        settingsRowTextEndClassName,
        settingsRowInteractiveClassName,
        // The plus takes a row icon's 15px slot, so the label lines up with icon rows.
        "min-h-11 gap-3 text-sm/4 text-muted-foreground hover:text-foreground disabled:opacity-50 pending:opacity-50",
      )}
      isDisabled={disabled}
      isPending={loading}
      onPress={onPress}
    >
      <span className="flex size-icon shrink-0 items-center justify-center">
        <PlusIcon aria-hidden className="size-3.5" />
      </span>
      <span className={cn(loading && "shimmer")}>{label}</span>
    </Button>
  );
}
