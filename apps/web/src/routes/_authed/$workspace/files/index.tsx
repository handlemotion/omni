import { createFileRoute, redirect } from "@tanstack/react-router";
import { NoTeamspaces } from "../../../../components/storage/storage-nav.tsx";
import { listSearch } from "../../../../lib/search-params.ts";
import { storageTeamspacesQuery } from "../../../../lib/storage-teamspaces.ts";

/**
 * `/files` opens the first teamspace, and with none the way to make one.
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
  },
  component: NoTeamspaces,
});
