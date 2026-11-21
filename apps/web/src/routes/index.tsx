import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireMember, requireUser } from "../lib/guards.ts";
import { hasPendingInvitations } from "../lib/invitations.ts";
import { isServerPath, takeSignInRedirect } from "../lib/session.ts";
import { homeWorkspace, workspaceHome, workspacesWith } from "../lib/workspaces.ts";

/** `/` opens the session's workspace's Inbox, after any invitations waiting for the person. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context, location }) => {
    const client = context.queryClient;
    const resume = takeSignInRedirect();
    if (resume)
      throw redirect({ href: resume, replace: true, reloadDocument: isServerPath(resume) });
    const { user } = await requireUser(client, location);
    if (await hasPendingInvitations(client, user.id))
      throw redirect({ to: "/welcome", replace: true });
    await requireMember(client, location);
    const home = homeWorkspace(await workspacesWith(client, (d) => !!homeWorkspace(d)));
    if (home) throw redirect({ href: workspaceHome(home.slug), replace: true });
  },
});
