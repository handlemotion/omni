import { useQuery } from "@tanstack/react-query";
import { useStorageList } from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageSearchQuery } from "@/lib/storage-find.ts";

const PDF = "application/pdf";

/** Where the picker is: a teamspace's top or a folder; null is the list of spaces. */
export type TeamFilesAt = { teamspaceId: string } | { parentId: string } | null;

/**
 * The team's files a contract may reference (`docs/spec/contracts.md`, "In the CRM"): a search
 * for `q` narrowed on the server before its limit, or else what is at `at`. With `pdfOnly`, only
 * PDFs, and folders to browse into.
 */
export function useTeamFiles(q: string, at: TeamFilesAt, pdfOnly: boolean) {
  const list = useStorageList(at ?? { teamspaceId: "" }, { enabled: !q && !!at });
  const found = useQuery(
    storageSearchQuery(q, { drive: "team", ...(pdfOnly ? { type: PDF } : {}) }),
  );
  const nodes = (q ? (found.data?.nodes ?? []) : at ? list.nodes : []).filter(
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
