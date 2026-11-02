// Placeholder UI: account (passkeys, sign out) and organization switching.
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useAddPasskey,
  useDeletePasskey,
  usePasskeys,
} from "../../../../hooks/use-organization.ts";
import {
  useMember,
  useOrganizations,
  useSetActiveOrganization,
  useSignOut,
} from "../../../../hooks/use-session.ts";
import { organizationsQuery, passkeysQuery } from "../../../../lib/org-queries.ts";

export const Route = createFileRoute("/_authed/_member/settings/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(organizationsQuery()),
      context.queryClient.ensureQueryData(passkeysQuery()),
    ]),
  component: Settings,
});

function Settings() {
  const { user, member } = useMember();
  const organizations = useOrganizations();
  const switchOrg = useSetActiveOrganization();
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
        {organizations.data?.map((org) => (
          <li key={org.id}>
            {org.name}{" "}
            {org.id === member.orgId ? (
              "(active)"
            ) : (
              <button type="button" onClick={() => switchOrg.mutate(org.id)}>
                Switch
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
