import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireMember } from "../lib/guards.ts";
import { isServerPath, takeSignInRedirect } from "../lib/session.ts";
import { homeWorkspace, workspaceHome, workspacesWith } from "../lib/workspaces.ts";

/** `/` opens the session's workspace's Inbox (ADR 0043). */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context, location }) => {
    const client = context.queryClient;
    // A desktop sign-in lands here (the shell reloads at `/`): resume where it started. That
    // page's own guards decide what a signed-out or joining visitor sees.
    const resume = takeSignInRedirect();
    if (resume)
      throw redirect({ href: resume, replace: true, reloadDocument: isServerPath(resume) });
    // Signed out, joining or still setting up: the member guard sends them where they belong.
    await requireMember(client, location);
    const home = homeWorkspace(await workspacesWith(client, (d) => !!homeWorkspace(d)));
    if (home) throw redirect({ href: workspaceHome(home.slug), replace: true });
  },
});
