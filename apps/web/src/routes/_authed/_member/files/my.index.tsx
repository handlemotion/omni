import { createFileRoute } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/_member/files/my/")({
  validateSearch: filesSearch,
  loader: ({ context }) =>
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ space: "personal" })),
  component: () => <FileList space="personal" />,
});
