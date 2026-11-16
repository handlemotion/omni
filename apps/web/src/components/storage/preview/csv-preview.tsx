// A CSV or TSV: its first rows, parsed by Papa Parse (it finds the delimiter and the quoting),
// as a table of text cells with the first row as the header. Loaded on its own chunk.
import Papa from "papaparse";
import { useMemo } from "react";
import { useFileText } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { SheetTable } from "./sheet-table.tsx";
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

function Sheet(props: { text: string; partial: boolean }) {
  const rows = useMemo(() => {
    const parsed = Papa.parse<string[]>(props.text, { preview: ROWS + 1, skipEmptyLines: true });
    // A file read in part ends mid-row: drop that row rather than show it cut.
    return props.partial && parsed.data.length <= ROWS ? parsed.data.slice(0, -1) : parsed.data;
  }, [props.text, props.partial]);
  return <SheetTable rows={rows} />;
}
