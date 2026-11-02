// Placeholder UI: accept or decline an invitation. Signed-in users only; they may not belong to
// any organization yet.
import { createFileRoute } from "@tanstack/react-router";
import {
  useAcceptInvitation,
  useInvitation,
  useRejectInvitation,
} from "../../hooks/use-session.ts";
import { invitationQuery } from "../../lib/org-queries.ts";

export const Route = createFileRoute("/_authed/invite/$invitationId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(invitationQuery(params.invitationId)),
  component: Invite,
});

function Invite() {
  const { invitationId } = Route.useParams();
  const navigate = Route.useNavigate();
  const invitation = useInvitation(invitationId);
  const accept = useAcceptInvitation();
  const reject = useRejectInvitation();

  // The loader fetched it; a failed load renders the route's error boundary instead.
  if (!invitation.data) return null;
  return (
    <main>
      <pre>{JSON.stringify(invitation.data, null, 2)}</pre>
      <button
        type="button"
        onClick={() =>
          accept.mutate(invitationId, { onSuccess: () => void navigate({ to: "/inbox" }) })
        }
      >
        Accept
      </button>
      <button type="button" onClick={() => reject.mutate(invitationId)}>
        Decline
      </button>
      {(accept.error ?? reject.error) && <p>{(accept.error ?? reject.error)?.message}</p>}
    </main>
  );
}
