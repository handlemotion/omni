import Papa from "papaparse";
import { useMemo } from "react";
import { useFileText } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { SheetTable } from "./sheet-table.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

const ROWS = 500;

export default function CsvPreview(props: {
  source: PreviewSource;
  onDownload?: (() => void) | undefined;
}) {
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
    return props.partial && parsed.data.length <= ROWS ? parsed.data.slice(0, -1) : parsed.data;
  }, [props.text, props.partial]);
  return <SheetTable rows={rows} />;
}
