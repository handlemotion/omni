import { cn } from "cn";
import type { ReactNode } from "react";
import { Meter, MeterTrack } from "@/components/ui/meter";
import { settingsRowLabelClassName } from "./settings-row";

/**
 * How much of something there is: the name (and a muted `hint`) on the left, the `amount` on the
 * right, the bar under both. One line of text. The bar is the brand colour; `warn` turns it red
 * for a limit that's nearly reached.
 */
export function SettingsMeterRow({
  amount,
  hint,
  label,
  max = 100,
  value,
  warn,
}: {
  /** The figure on the right: "12 of 40 unread". */
  amount?: ReactNode;
  hint?: ReactNode;
  label: string;
  max?: number;
  value: number;
  warn?: boolean;
}) {
  return (
    <Meter
      aria-label={label}
      className="flex min-h-16 flex-col justify-center gap-3 px-4 py-3.5"
      maxValue={Math.max(max, 1)}
      value={Math.min(value, max)}
      color={warn ? "var(--color-danger)" : "var(--color-primary)"}
    >
      <div className={cn(settingsRowLabelClassName, "flex min-w-0 items-baseline gap-3")}>
        <span className="min-w-0 flex-1 truncate">
          {label}
          {hint && <span className="text-muted-foreground"> ({hint})</span>}
        </span>
        {amount && <span className="shrink-0 text-muted-foreground tabular-nums">{amount}</span>}
      </div>
      <MeterTrack />
    </Meter>
  );
}
