import { useMutation } from "@tanstack/react-query";
import type { DocExport } from "@/components/storage/editor/export-doc.ts";
import { docImageBytes, docImageFile } from "@/lib/doc-files.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { fileText } from "@/lib/storage-export.ts";

/** What a doc can be exported as: a file the browser saves, or its Markdown on the clipboard. */
export type DocExportAction = DocExport | "copy";

/**
 * Exports a doc: a Word or Markdown file the browser downloads, a PDF through the print dialog,
 * or its Markdown copied. `text` is the doc as the editor holds it now; without it, as saved.
 */
export function useExportDoc() {
  return useMutation({
    mutationFn: async (input: { node: StorageNode; format: DocExportAction; text?: string }) => {
      const text = input.text ?? (await fileText(input.node));
      if (input.format === "copy") return navigator.clipboard.writeText(text);
      const module = await import("@/components/storage/editor/export-doc.ts");
      await module.exportDoc(text, input.node.name, input.format, async (src) => {
        const id = docImageFile(src);
        return id ? docImageBytes(id, undefined) : null;
      });
    },
  });
}
