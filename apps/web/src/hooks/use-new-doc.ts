import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DOC_TYPE } from "@omni/docs/file";
import { storageChanged, type StorageNode, type StoragePlace } from "@/lib/storage.ts";
import { uploadFile } from "@/lib/storage-upload.ts";
import { identityChecks, identityOf } from "@/lib/storage-uploads.ts";

/** The name a new doc gets; the server numbers it when the folder has one already. */
export const NEW_DOC_NAME = "Untitled";

/** Makes an empty Omni doc in `place`, and hands it to `onMade`. */
export function useNewDoc(
  place: StoragePlace,
  shareId: string | undefined,
  onMade: (node: StorageNode) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const signal = new AbortController().signal;
      return uploadFile({
        file: new File([""], NEW_DOC_NAME, { type: DOC_TYPE }),
        place,
        shareId,
        signal,
        onOpened: () => {},
        onProgress: () => {},
        ...identityChecks(client, shareId, identityOf(client, shareId), signal),
      });
    },
    onSuccess: (node) => {
      void storageChanged(client);
      onMade(node);
    },
  });
}
