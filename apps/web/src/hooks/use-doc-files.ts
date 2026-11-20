import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { docImageFile, docImagePath, docImageQuery } from "@/lib/doc-files.ts";
import { storageChanged, type StorageNode } from "@/lib/storage.ts";
import { storageSearchQuery } from "@/lib/storage-find.ts";
import { revokePreviewUrls } from "@/lib/storage-preview.ts";
import { uploadFile } from "@/lib/storage-upload.ts";
import { identityChecks, identityOf } from "@/lib/storage-uploads.ts";

/** What a doc does with other Drive files: shows images, takes new ones, and finds files to link. */
export interface DocFiles {
  /** Adds an image to the doc, and answers the path the doc's Markdown shows it by. */
  upload: (file: File) => Promise<string>;
  /** A URL the page may show an image of the doc by, or null when it is not a Drive file. */
  image: (src: string) => Promise<string | null>;
  /** Files whose name holds `q`, for an @ link (none through a shared link). */
  find: (q: string) => Promise<StorageNode[]>;
}

/** The Drive side of a doc's images and links, for the doc `file`. */
export function useDocFiles(file: StorageNode, shareId: string | undefined) {
  const client = useQueryClient();
  revokePreviewUrls(client);
  return useMemo(() => {
    const files: DocFiles = {
      upload: async (picked) => {
        const signal = new AbortController().signal;
        const made = await uploadFile({
          file: picked,
          place: { parentId: file.id },
          shareId,
          signal,
          onOpened: () => {},
          onProgress: () => {},
          ...identityChecks(client, shareId, identityOf(client, shareId), signal),
        });
        void storageChanged(client);
        return docImagePath(made.id);
      },
      image: async (src) => {
        const id = docImageFile(src);
        return id ? (await client.fetchQuery(docImageQuery(id, shareId))).url : null;
      },
      find: async (q) =>
        shareId || !q.trim()
          ? []
          : (await client.fetchQuery(storageSearchQuery(q))).nodes.filter(
              (node) => node.kind === "file" && node.id !== file.id,
            ),
    };
    return files;
  }, [client, file.id, shareId]);
}
