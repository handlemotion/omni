import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireMember } from "../lib/guards.ts";
import { homeWorkspace, workspaceHome, workspacesWith } from "../lib/workspaces.ts";

/** `/` opens the session's workspace's Inbox (ADR 0043). */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context, location }) => {
    const client = context.queryClient;
    // Signed out, joining or still setting up: the member guard sends them where they belong.
    await requireMember(client, location);
    const home = homeWorkspace(await workspacesWith(client, (d) => !!homeWorkspace(d)));
    if (home) throw redirect({ href: workspaceHome(home.slug), replace: true });
  },
});
