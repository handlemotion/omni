// Placeholder UI: account (passkeys, sign out) and organization switching.
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useAddPasskey,
  useDeletePasskey,
  usePasskeys,
} from "../../../../hooks/use-organization.ts";
import { useMember, useSignOut } from "../../../../hooks/use-session.ts";
import { useOpenWorkspace, useWorkspaces } from "../../../../hooks/use-workspaces.ts";
import { passkeysQuery } from "../../../../lib/org-queries.ts";
import { workspacesQuery } from "../../../../lib/workspaces.ts";

export const Route = createFileRoute("/_authed/_member/settings/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(workspacesQuery()),
      context.queryClient.ensureQueryData(passkeysQuery()),
    ]),
  component: Settings,
});

function Settings() {
  const { user, member } = useMember();
  const workspaces = useWorkspaces();
  const openWorkspace = useOpenWorkspace();
  const passkeys = usePasskeys();
  const addPasskey = useAddPasskey();
  const deletePasskey = useDeletePasskey();
  const signOut = useSignOut();

  return (
    <main>
      <p>
        {user.email} · role {member.role}
      </p>
      <h2>Organizations</h2>
      <ul>
        {workspaces.data?.workspaces.map((org) => (
          <li key={org.id}>
            {org.name}
            {org.setup !== "complete" && ` (setup: ${org.setup})`}{" "}
            {org.id === member.orgId && org.setup === "complete" ? (
              "(active)"
            ) : (
              <button type="button" onClick={() => openWorkspace.mutate(org)}>
                {org.id === member.orgId ? "Continue setup" : "Switch"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <Link to="/settings/organization">Members and invitations</Link>
      <h2>Passkeys</h2>
      <ul>
        {passkeys.data?.map((p) => (
          <li key={p.id}>
            {p.name ?? p.id}{" "}
            <button type="button" onClick={() => deletePasskey.mutate(p.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => addPasskey.mutate(undefined)}>
        Add a passkey
      </button>
      {addPasskey.error && <p>{addPasskey.error.message}</p>}
      <button type="button" onClick={() => signOut.mutate()}>
        Sign out
      </button>
    </main>
  );
}
