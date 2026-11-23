import { createFileRoute, redirect } from "@tanstack/react-router";

/** My files and Shared are retired (`docs/spec/teamspaces.md`): an old link opens Drive. */
export const Route = createFileRoute("/_authed/$workspace/files/my/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$workspace/files", params: { workspace: params.workspace } });
  },
});
