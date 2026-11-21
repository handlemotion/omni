import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DOC_TYPE, isOmniDoc } from "@omni/docs/file";
import { bulkFailure } from "@/components/storage/file-dialogs.tsx";
import { storageErrorToast } from "@/components/storage/storage-errors.ts";
import { appToast } from "@/components/ui/toast";
import { useChangeNode } from "@/hooks/use-storage.ts";
import { eachAtMost } from "@/lib/each-at-most.ts";
import { storageChanged, type StorageNode } from "@/lib/storage.ts";
import { fileTextExact } from "@/lib/storage-export.ts";
import { abortUpload, uploadFile } from "@/lib/storage-upload.ts";
import { identityChecks, identityOf } from "@/lib/storage-uploads.ts";

const MARKDOWN_NAME = /\.(md|markdown)$/i;
const AT_ONCE = 4;

/** Whether a file is a Markdown file that can become an Omni doc. */
export const canConvertToDoc = (node: StorageNode) =>
  node.kind === "file" &&
  !node.lockedAt &&
  !isOmniDoc(node.mimeType) &&
  MARKDOWN_NAME.test(node.name);

/**
 * Turns Markdown files into Omni docs: each one's text is saved as its next version with the doc
 * type, so the Markdown file stays in Versions, then `.md` leaves its name.
 */
export function useConvertToDoc() {
  const client = useQueryClient();
  const rename = useChangeNode();
  const [isPending, setPending] = useState(false);
  const convert = async (node: StorageNode) => {
    const signal = new AbortController().signal;
    const text = await fileTextExact(node);
    let opened: string | undefined;
    try {
      await uploadFile({
        file: new File([text], node.name, { type: DOC_TYPE }),
        place: node.parentId ? { parentId: node.parentId } : { space: node.space },
        replaces: node.id,
        ifContentVersion: node.contentVersion,
        shareId: undefined,
        signal,
        onOpened: (uploadId) => {
          opened = uploadId;
        },
        onProgress: () => {},
        ...identityChecks(client, undefined, identityOf(client, undefined), signal),
      });
    } catch (error) {
      if (opened) void abortUpload(opened);
      throw error;
    }
    await rename.mutateAsync({ id: node.id, name: node.name.replace(MARKDOWN_NAME, "") });
  };
  const run = async (nodes: StorageNode[]) => {
    const files = nodes.filter(canConvertToDoc);
    if (files.length === 0) return;
    setPending(true);
    const failed = await eachAtMost(files, AT_ONCE, convert);
    setPending(false);
    void storageChanged(client);
    const [first] = failed;
    if (first)
      storageErrorToast(first.error, bulkFailure("converted", failed.length, files.length));
    else
      appToast.success(
        files.length === 1 ? "Converted to a doc" : `${files.length} converted to docs`,
      );
  };
  return { run, isPending };
}
