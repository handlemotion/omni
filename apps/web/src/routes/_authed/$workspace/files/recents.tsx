import { createFileRoute } from "@tanstack/react-router";
import { Recents } from "../../../../components/storage/recents.tsx";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageRecentQuery } from "../../../../lib/storage-find.ts";
import { storageSharedWithMeQuery } from "../../../../lib/storage-sharing.ts";

export const Route = createFileRoute("/_authed/$workspace/files/recents")({
  validateSearch: listSearch,
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(storageRecentQuery());
    void context.queryClient.prefetchInfiniteQuery(storageSharedWithMeQuery());
  },
  component: Recents,
});
