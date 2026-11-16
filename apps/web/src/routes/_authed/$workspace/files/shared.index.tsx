import { createFileRoute, redirect } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { filesSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";

export const Route = createFileRoute("/_authed/$workspace/files/shared/")({
  validateSearch: filesSearch,
  // A Personal space has no Shared (ADR 0034 decision 1): its My files instead.
  beforeLoad: ({ context, params, search }) => {
    if (context.workspace.kind === "personal") {
      throw redirect({ to: "/$workspace/files/my", params, search });
    }
  },
  loader: ({ context }) =>
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ space: "shared" })),
  component: () => <FileList space="shared" />,
});
