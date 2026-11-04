import { IconChevronDown } from "@/components/icons/lucide";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Button } from "react-aria-components/Button";
import { Disclosure, DisclosurePanel } from "react-aria-components/Disclosure";
import {
  settingsRowAvatarClassName,
  settingsRowClassName,
  settingsRowInteractiveClassName,
  settingsRowTextEndClassName,
  SettingsRowText,
  type SettingsRowIcon,
} from "./settings-row";

/**
 * A row that opens in place to show more: a list of rows, a form. The rows inside are indented
 * past the row's own lead, so they read as its children.
 */
export function SettingsCollapsibleRow({
  children,
  defaultOpen,
  onOpenChange,
  open,
  value,
  ...text
}: {
  avatar?: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: ReactNode;
  icon?: SettingsRowIcon;
  label: ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  /** A short summary shown before the chevron (a count, the current value). */
  value?: ReactNode;
}) {
  return (
    <Disclosure
      className="group/settings-collapsible"
      defaultExpanded={defaultOpen}
      isExpanded={open}
      onExpandedChange={onOpenChange}
    >
      <Button
        slot="trigger"
        className={cn(
          settingsRowClassName,
          settingsRowTextEndClassName,
          settingsRowInteractiveClassName,
          text.avatar && settingsRowAvatarClassName,
        )}
      >
        <SettingsRowText {...text} />
        {value && (
          <span className="max-w-56 shrink-0 truncate text-sm/4 text-muted-foreground tabular-nums">
            {value}
          </span>
        )}
        <IconChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-expanded/settings-collapsible:rotate-180 motion-reduce:transition-none" />
      </Button>
      {/* Shown only while open: a collapsed panel's border would double the hairline below. */}
      <DisclosurePanel className="hidden flex-col divide-y divide-border border-t border-border group-expanded/settings-collapsible:flex *:ps-8">
        {children}
      </DisclosurePanel>
    </Disclosure>
  );
}
