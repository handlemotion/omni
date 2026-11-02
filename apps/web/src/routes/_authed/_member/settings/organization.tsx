// Placeholder UI: members and invitations of the active organization.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  useCancelInvitation,
  useInvitations,
  useInviteMember,
  useMembers,
  useRemoveMember,
} from "../../../../hooks/use-organization.ts";
import { invitationsQuery, membersQuery } from "../../../../lib/org-queries.ts";

export const Route = createFileRoute("/_authed/_member/settings/organization")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(membersQuery()),
      context.queryClient.ensureQueryData(invitationsQuery()),
    ]),
  component: Organization,
});

function Organization() {
  const members = useMembers();
  const invitations = useInvitations();
  const invite = useInviteMember();
  const cancel = useCancelInvitation();
  const remove = useRemoveMember();
  const [email, setEmail] = useState("");

  return (
    <main>
      <h2>Members</h2>
      <pre>{JSON.stringify(members.data, null, 2)}</pre>
      <input value={email} onChange={(event) => setEmail(event.target.value)} />
      <button type="button" onClick={() => invite.mutate({ email })}>
        Invite
      </button>
      <button type="button" onClick={() => remove.mutate(email)}>
        Remove member by email
      </button>
      {(invite.error ?? remove.error) && <p>{(invite.error ?? remove.error)?.message}</p>}
      <h2>Invitations</h2>
      <ul>
        {invitations.data?.map((i) => (
          <li key={i.id}>
            {i.email} · {i.status}{" "}
            <button type="button" onClick={() => cancel.mutate(i.id)}>
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
