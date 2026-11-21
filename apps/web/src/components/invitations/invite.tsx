import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { appToast } from "@/components/ui/toast";
import { useInvitationStatus, useRefreshInvitations } from "@/hooks/use-invitations";
import { useAcceptInvitation, useRejectInvitation, useSignOut } from "@/hooks/use-session";
import type { InvitationStatus } from "@/lib/types";
import { EntryCard, inviterName } from "./entry-card";

type Shown = InvitationStatus | { status: "not_found" } | { status: "unavailable" };

function title(shown: Shown) {
  if (shown.status === "wrong_account") return "This invitation is for another email";
  if (shown.status === "not_found") return "This invitation doesn't exist";
  if (shown.status === "unavailable") return "This invitation couldn't load";
  const workspace = shown.invitation.organization.name;
  if (shown.status === "expired") return `Your invitation to ${workspace} has expired`;
  if (shown.status === "accepted") return `You're in ${workspace}`;
  if (shown.status === "declined") return `You declined the invitation to ${workspace}`;
  return `${inviterName(shown.invitation.inviter)} invited you to ${workspace}`;
}

/** `/invite/<id>`: the invitation emailed to the person, in the sign-in card's frame. */
export function Invite(props: { invitationId: string }) {
  const navigate = useNavigate();
  const status = useInvitationStatus(props.invitationId);
  const refresh = useRefreshInvitations();
  const accept = useAcceptInvitation();
  const reject = useRejectInvitation();
  const signOut = useSignOut();
  if (status.isPending) return null;
  const shown: Shown =
    status.data ?? (status.missing ? { status: "not_found" } : { status: "unavailable" });
  const home = () => void navigate({ to: "/" });
  const busy = accept.isPending || reject.isPending;

  const actions =
    shown.status === "pending" ? (
      <>
        <Button
          size="lg"
          isDisabled={busy && !accept.isPending}
          isPending={accept.isPending}
          onPress={() =>
            accept.mutate(props.invitationId, {
              onSuccess: home,
              onError: (error) => appToast.error(error.message || "You could not join."),
            })
          }
        >
          Join
        </Button>
        <Button
          size="lg"
          intent="outline"
          isDisabled={busy && !reject.isPending}
          isPending={reject.isPending}
          onPress={() =>
            reject.mutate(props.invitationId, {
              onSuccess: () => void refresh(props.invitationId),
              onError: (error) =>
                appToast.error(error.message || "The invitation was not declined."),
            })
          }
        >
          Decline
        </Button>
      </>
    ) : shown.status === "unavailable" ? (
      <Button size="lg" isPending={status.isFetching} onPress={() => void status.refetch()}>
        Try again
      </Button>
    ) : shown.status === "wrong_account" ? (
      <Button size="lg" isPending={signOut.isPending} onPress={() => signOut.mutate()}>
        Use another account
      </Button>
    ) : (
      <Button size="lg" onPress={home}>
        Continue
      </Button>
    );

  return <EntryCard title={title(shown)} actions={actions} />;
}
