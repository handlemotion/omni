import { createFileRoute } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/t/$teamspaceId/$folderId")({
  validateSearch: filesSearch,
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ parentId: params.folderId })),
  component: Folder,
});

function Folder() {
  const { teamspaceId, folderId } = Route.useParams();
  return <FileList key={folderId} drive={{ teamspaceId }} folderId={folderId} />;
}
