import { createFileRoute } from "@tanstack/react-router";
import { Invite } from "../../components/invitations/invite.tsx";
import { leaveWorkspace } from "../../lib/current-workspace.ts";
import { invitationStatusQuery } from "../../lib/invitations.ts";

export const Route = createFileRoute("/_authed/invite/$invitationId")({
  beforeLoad: ({ preload }) => leaveWorkspace(preload),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(invitationStatusQuery(params.invitationId)).catch(() => {}),
  component: InvitePage,
});

function InvitePage() {
  const { invitationId } = Route.useParams();
  return <Invite invitationId={invitationId} />;
}
