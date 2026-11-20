import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import { useFileSheets } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { SheetGrid } from "./sheet-grid.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

export default function XlsxPreview(props: {
  source: PreviewSource;
  onDownload?: (() => void) | undefined;
}) {
  const sheets = useFileSheets(props.source);
  if (sheets.isError || sheets.data?.length === 0) {
    return <NoPreview kind="spreadsheet" onDownload={props.onDownload} />;
  }
  if (!sheets.data) return <StageLoading label="Loading spreadsheet" />;
  const [only] = sheets.data;
  if (sheets.data.length === 1 && only) return <SheetGrid rows={only.rows} />;
  return (
    <Tabs className="min-h-0 w-full flex-1 gap-0">
      <TabList aria-label="Sheets" className="shrink-0 overflow-x-auto px-5">
        {sheets.data.map((sheet, i) => (
          <Tab key={i} id={String(i)}>
            {sheet.name}
          </Tab>
        ))}
      </TabList>
      {sheets.data.map((sheet, i) => (
        <TabPanel key={i} id={String(i)} className="flex min-h-0 flex-col">
          <SheetGrid rows={sheet.rows} />
        </TabPanel>
      ))}
    </Tabs>
  );
}
