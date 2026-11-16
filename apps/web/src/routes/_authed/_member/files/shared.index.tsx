import { createFileRoute, redirect } from "@tanstack/react-router";
import { FileList } from "../../../../components/storage/file-list.tsx";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";
import { workspacesQuery } from "../../../../lib/workspaces.ts";

export const Route = createFileRoute("/_authed/_member/files/shared/")({
  validateSearch: listSearch,
  // A Personal space has no Shared (ADR 0034 decision 1): its My files instead.
  beforeLoad: async ({ context, search }) => {
    const { activeOrganizationId, workspaces } =
      await context.queryClient.ensureQueryData(workspacesQuery());
    if (workspaces.find((w) => w.id === activeOrganizationId)?.kind === "personal") {
      throw redirect({ to: "/files/my", search });
    }
  },
  loader: ({ context }) =>
    void context.queryClient.prefetchInfiniteQuery(storageListQuery({ space: "shared" })),
  component: () => <FileList space="shared" />,
});
