import { createFileRoute } from "@tanstack/react-router";
import { SharedWithMe } from "../../../../components/storage/shared-with-me.tsx";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageSharedWithMeQuery } from "../../../../lib/storage-sharing.ts";

export const Route = createFileRoute("/_authed/$workspace/files/shared-with-me")({
  validateSearch: listSearch,
  loader: ({ context }) =>
    void context.queryClient.prefetchInfiniteQuery(storageSharedWithMeQuery()),
  component: SharedWithMe,
});
