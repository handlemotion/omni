import { cn } from "cn";
import type { ReactNode } from "react";
import { SettingsRow, settingsRowTextEndClassName, type SettingsRowIcon } from "./settings-row";

/** A read-only fact: an email, a slug, a count, a status. */
export function SettingsValueRow({
  mono,
  tone = "default",
  value,
  ...text
}: {
  avatar?: ReactNode;
  badge?: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  icon?: SettingsRowIcon;
  label: ReactNode;
  /** Codes, IDs, and keys. */
  mono?: boolean;
  /** `muted` for a value that is a state rather than data (Pending, Not set). */
  tone?: "default" | "muted" | "danger" | "success";
  value: ReactNode;
}) {
  return (
    <SettingsRow
      {...text}
      className={settingsRowTextEndClassName}
      control={
        <span
          className={cn(
            "max-w-56 truncate text-sm/4 tabular-nums",
            mono && "font-mono text-xs/4",
            tone === "default" && "text-foreground",
            tone === "muted" && "text-muted-foreground",
            tone === "danger" && "text-danger-subtle-foreground",
            tone === "success" && "text-success-subtle-foreground",
          )}
        >
          {value}
        </span>
      }
    />
  );
}
