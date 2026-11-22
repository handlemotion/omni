import { createFileRoute, redirect } from "@tanstack/react-router";
import { NoTeamspaces } from "../../../../components/storage/storage-nav.tsx";
import { ApiError } from "../../../../lib/api.ts";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageListQuery } from "../../../../lib/storage.ts";
import { storageTeamspacesQuery } from "../../../../lib/storage-teamspaces.ts";

/**
 * `/files` opens the first teamspace; with none, My files or Shared while they hold something,
 * and otherwise the way to make one.
 */
export const Route = createFileRoute("/_authed/$workspace/files/")({
  validateSearch: listSearch,
  beforeLoad: async ({ context, params, search }) => {
    const { queryClient } = context;
    const teamspaces = await queryClient.ensureQueryData(storageTeamspacesQuery());
    const first =
      teamspaces.teamspaces.find((teamspace) => teamspace.role !== null) ??
      teamspaces.teamspaces[0];
    if (first) {
      throw redirect({
        to: "/$workspace/files/t/$teamspaceId",
        params: { ...params, teamspaceId: first.id },
        search,
      });
    }
    for (const space of ["shared", "personal"] as const) {
      const page = await queryClient
        .ensureInfiniteQueryData(storageListQuery({ space }))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        });
      if (page?.pages[0]?.nodes.length) {
        throw redirect({
          to: `/$workspace/files/${space === "personal" ? "my" : "shared"}`,
          params,
          search,
        });
      }
    }
  },
  component: NoTeamspaces,
});
