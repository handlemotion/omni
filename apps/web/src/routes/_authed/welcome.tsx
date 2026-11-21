import { createFileRoute, redirect } from "@tanstack/react-router";
import { Welcome } from "../../components/invitations/welcome.tsx";
import { leaveWorkspace } from "../../lib/current-workspace.ts";
import { pendingInvitations } from "../../lib/invitations.ts";
import { onboardingQuery } from "../../lib/onboarding.ts";
import { sessionQuery } from "../../lib/session.ts";

/**
 * Invitations first, and the way in for someone in no workspace yet. A member with nothing
 * waiting goes on to their inbox.
 */
export const Route = createFileRoute("/_authed/welcome")({
  beforeLoad: async ({ context, preload }) => {
    leaveWorkspace(preload);
    const client = context.queryClient;
    const [session, pending] = await Promise.all([
      client.ensureQueryData(sessionQuery()),
      pendingInvitations(client, true),
    ]);
    if (session?.member && pending.length === 0) throw redirect({ to: "/", replace: true });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(onboardingQuery()),
  component: Welcome,
});
