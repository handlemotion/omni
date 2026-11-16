// A CSV or TSV: its first rows, parsed by Papa Parse (it finds the delimiter and the quoting),
// as a table of text cells with the first row as the header. Loaded on its own chunk.
import Papa from "papaparse";
import { memo, useMemo } from "react";
import { useFileText } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { NoPreview, StageLoading } from "./shared.tsx";

/** Rows shown: a preview, not a spreadsheet. */
const ROWS = 500;

export default function CsvPreview(props: { source: PreviewSource; onDownload: () => void }) {
  const text = useFileText(props.source);
  if (text.isError || text.data?.binary) {
    return <NoPreview kind="csv" onDownload={props.onDownload} />;
  }
  if (!text.data) return <StageLoading label="Loading table" />;
  return <Sheet text={text.data.text} partial={text.data.partial} />;
}

const Sheet = memo(function Sheet(props: { text: string; partial: boolean }) {
  const rows = useMemo(() => {
    const parsed = Papa.parse<string[]>(props.text, { preview: ROWS + 1, skipEmptyLines: true });
    // A file read in part ends mid-row: drop that row rather than show it cut.
    return props.partial && parsed.data.length <= ROWS ? parsed.data.slice(0, -1) : parsed.data;
  }, [props.text, props.partial]);
  const [head = [], ...body] = rows;
  const columns = Math.max(head.length, ...body.slice(0, 50).map((row) => row.length));
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <table className="min-w-full border-separate border-spacing-0 text-sm tabular-nums">
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, i) => (
              <th
                key={i}
                scope="col"
                className="sticky top-0 border-b bg-background px-3 py-2 text-start text-xs font-normal whitespace-nowrap text-muted-foreground first:ps-5"
              >
                {head[i] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: columns }, (_, c) => (
                <td
                  key={c}
                  className="max-w-64 truncate border-b px-3 py-2 whitespace-nowrap text-foreground first:ps-5"
                >
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
