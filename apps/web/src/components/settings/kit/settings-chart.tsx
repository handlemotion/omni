// A chart inside a settings group (transitive's usage chart): stacked columns, one per category on
// the x axis, a series per key. Quiet: no grid, a short y axis, the tooltip on hover, the legend
// under it. Colours are the chart tokens in config order.
import type { ChartConfig } from "@/components/ui/chart";
import { BarChart } from "@/components/ui/bar-chart";

export function SettingsChart({
  config,
  data,
  dataKey,
  height = 200,
}: {
  config: ChartConfig;
  /** One row per column: its `dataKey` label and a number per series. */
  data: Record<string, string | number>[];
  dataKey: string;
  height?: number;
}) {
  return (
    <div className="px-4 pt-4 pb-3">
      <BarChart
        config={config}
        data={data}
        dataKey={dataKey}
        type="stacked"
        containerHeight={height}
        barCategoryGap={24}
        hideGridLines
        yAxisProps={{ width: 28, allowDecimals: false }}
        chartProps={{ margin: { top: 4, right: 0, bottom: 0, left: 0 } }}
        legendProps={{
          wrapperStyle: { paddingTop: 12 },
          // In config order (the stack's order), not recharts' alphabetical default.
          itemSorter: (item) => Object.keys(config).indexOf(String(item.dataKey)),
        }}
      />
    </div>
  );
}
