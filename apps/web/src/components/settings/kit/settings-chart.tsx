// A chart inside a settings group (transitive's usage chart): stacked columns, one per category on
// the x axis, a series per key. Quiet: no grid, a short y axis, the tooltip on hover. No legend:
// the group's series rows under the chart (`SettingsSeriesRow`) say whose each colour is, with
// its total. Colours are the chart tokens in config order.
import type { CSSProperties } from "react";
import { type ChartConfig, ChartTooltipContent } from "@/components/ui/chart";
import { BarChart } from "@/components/ui/bar-chart";

export function SettingsChart({
  config,
  data,
  dataKey,
  label,
}: {
  config: ChartConfig;
  /** One row per column: its `dataKey` label and a number per series. */
  data: Record<string, string | number>[];
  dataKey: string;
  /** What the chart shows, for assistive tech. */
  label: string;
}) {
  return (
    <figure aria-label={label} className="min-w-0 px-3.5 pt-4 pb-3.5">
      <BarChart
        config={config}
        data={data}
        dataKey={dataKey}
        type="stacked"
        containerHeight={220}
        barCategoryGap={24}
        hideGridLines
        legend={false}
        yAxisProps={{ width: 28, allowDecimals: false }}
        chartProps={{ margin: { top: 4, right: 0, bottom: 0, left: 0 } }}
        tooltip={
          <ChartTooltipContent
            formatter={(value, name, item) => (
              <TooltipRow
                label={String(config[String(name)]?.label ?? name)}
                value={Number(value)}
                color={String(item.color ?? item.payload?.fill ?? "")}
              />
            )}
          />
        }
      />
    </figure>
  );
}

/** A series in the tooltip as its row says it under the chart: swatch, name, number. */
function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  if (value === 0) return null;
  return (
    <div className="flex w-full min-w-36 items-center justify-between gap-4">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px] bg-(--swatch)"
          style={{ "--swatch": color } as CSSProperties}
        />
        {label}
      </span>
      <span className="text-foreground tabular-nums">{value}</span>
    </div>
  );
}
