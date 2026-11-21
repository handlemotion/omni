import type { ComponentType } from "react";
import { IconCopy, IconFilePdf, IconFileText, IconMarkdown } from "@/components/icons/central";
import { appToast } from "@/components/ui/toast";
import { useExportDoc, type DocExportAction } from "@/hooks/use-export-doc.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageErrorToast } from "../storage-errors.ts";

/** One way a doc leaves Omni, as a menu row. */
export interface DocExportItem {
  format: DocExportAction;
  label: string;
  icon: ComponentType<{ className?: string; "data-slot"?: string }>;
}

export const DOC_EXPORTS: DocExportItem[] = [
  { format: "docx", label: "Word", icon: IconFileText },
  { format: "pdf", label: "PDF", icon: IconFilePdf },
  { format: "md", label: "Markdown", icon: IconMarkdown },
  { format: "copy", label: "Copy as Markdown", icon: IconCopy },
];

/**
 * Exports a doc as the editor holds it now (`text`), unsaved typing included: Word, PDF or
 * Markdown downloaded, or its Markdown copied.
 */
export function useDocExport(
  node: StorageNode,
  text: () => string | undefined,
  shareId?: string | undefined,
) {
  const exporting = useExportDoc();
  return (format: DocExportAction) =>
    exporting.mutate(
      { node, format, text: text(), shareId },
      {
        onSuccess: () => {
          if (format === "copy") appToast.success("Copied as Markdown");
        },
        onError: (error) => storageErrorToast(error, `“${node.name}” was not exported`),
      },
    );
}
