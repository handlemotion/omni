// One series of a chart, as a row under it in the same group (transitive's `UsageSeriesRow`): the
// rows are the chart's legend. Its name with its chart colour beside it, and its total.
import type { CSSProperties, ReactNode } from "react";
import { SettingsRow, settingsRowTextEndClassName } from "./settings-row";

export function SettingsSeriesRow({
  color,
  label,
  value,
}: {
  /** The series' colour in the chart, as a CSS colour (`var(--chart-1)`). */
  color: string;
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <SettingsRow
      badge={
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px] bg-(--swatch)"
          style={{ "--swatch": color } as CSSProperties}
        />
      }
      className={settingsRowTextEndClassName}
      control={<span className="text-sm text-muted-foreground tabular-nums">{value}</span>}
      label={label}
    />
  );
}
