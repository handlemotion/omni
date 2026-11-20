import { useMutation } from "@tanstack/react-query";
import type { DocExport } from "@/components/storage/editor/export-doc.ts";
import { docImageBytes, docImageFile } from "@/lib/doc-files.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { fileText } from "@/lib/storage-export.ts";

/** Turns a saved doc into a PDF (through the print dialog) or a Word file the browser downloads. */
export function useExportDoc() {
  return useMutation({
    mutationFn: async ({ node, format }: { node: StorageNode; format: DocExport }) => {
      const [text, module] = await Promise.all([
        fileText(node),
        import("@/components/storage/editor/export-doc.ts"),
      ]);
      await module.exportDoc(text, node.name, format, async (src) => {
        const id = docImageFile(src);
        return id ? docImageBytes(id, undefined) : null;
      });
    },
  });
}
