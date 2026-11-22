import { createFileRoute } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/t/$teamspaceId/")({
  validateSearch: filesSearch,
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(
      storageListQuery({ teamspaceId: params.teamspaceId }),
    ),
  component: Teamspace,
});

function Teamspace() {
  const { teamspaceId } = Route.useParams();
  return <FileList key={teamspaceId} drive={{ teamspaceId }} />;
}
