import { createFileRoute } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageDraftsQuery } from "../../../../lib/storage-find.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/drafts")({
  validateSearch: filesSearch,
  loader: async ({ context }) => {
    const { folderId } = await context.queryClient.ensureQueryData(storageDraftsQuery());
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ parentId: folderId }));
    return { folderId };
  },
  component: Drafts,
});

function Drafts() {
  const { folderId } = Route.useLoaderData();
  return <FileList key={folderId} drive={PERSONAL} folderId={folderId} />;
}

const PERSONAL = { space: "personal" } as const;
