import { createFileRoute } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/shared/")({
  validateSearch: filesSearch,
  loader: ({ context }) =>
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ space: "shared" })),
  component: () => <FileList drive={SHARED} />,
});

const SHARED = { space: "shared" } as const;
