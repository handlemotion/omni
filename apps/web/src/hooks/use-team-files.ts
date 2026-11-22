import { useQuery } from "@tanstack/react-query";
import { useStorageList } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageSearchQuery } from "@/lib/storage-find.ts";

const PDF = "application/pdf";

/**
 * The team's files a contract may reference (`docs/spec/contracts.md`, "In the CRM"), never My
 * files: a search for `q` narrowed on the server before its limit, or else the Shared folder at
 * `folderId` (its root when null). With `pdfOnly`, only PDFs, and folders to browse into.
 */
export function useTeamFiles(q: string, folderId: string | null, pdfOnly: boolean) {
  const list = useStorageList(folderId ? { parentId: folderId } : { space: "shared" }, {
    enabled: !q,
  });
  const found = useQuery(
    storageSearchQuery(q, { drive: "team", ...(pdfOnly ? { type: PDF } : {}) }),
  );
  const nodes = (q ? (found.data?.nodes ?? []) : list.nodes).filter(
    (node: StorageNode) =>
      !node.trashedAt &&
      node.space !== "personal" &&
      (node.kind === "folder" || !pdfOnly || node.mimeType === PDF),
  );
  return {
    nodes,
    loadMore: !q && list.hasNextPage ? () => void list.fetchNextPage() : undefined,
    isLoadingMore: list.isFetchingNextPage,
  };
}
