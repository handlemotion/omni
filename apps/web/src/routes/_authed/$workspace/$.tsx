import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Anything under a workspace that names no page. Its match is what lets the `$workspace` guard
 * see a path from before workspaces were in the URL (`/inbox/<id>`, `/settings/billing`) and send
 * it on; inside a real workspace it opens the Inbox.
 */
export const Route = createFileRoute("/_authed/$workspace/$")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$workspace/mail/inbox", params, replace: true });
  },
});
