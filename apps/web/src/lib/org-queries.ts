import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, auth, call } from "./api.ts";
import { currentWorkspaceId } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import { authCall } from "./session.ts";

type Role = "member" | "admin" | "owner";

export const organizationsQuery = () =>
  queryOptions({
    queryKey: keys.organizations(),
    queryFn: ({ signal }) => authCall(auth.organization.list({ fetchOptions: { signal } })),
  });

const organizationId = () => currentWorkspaceId();

/** Members of this tab's workspace. */
export const membersQuery = () =>
  queryOptions({
    queryKey: keys.members(),
    queryFn: ({ signal }) =>
      authCall(
        auth.organization.listMembers({
          query: { organizationId: organizationId() },
          fetchOptions: { signal },
        }),
      ),
  });

/** Invitations sent by this tab's workspace. */
export const invitationsQuery = () =>
  queryOptions({
    queryKey: keys.invitations(),
    queryFn: ({ signal }) =>
      authCall(
        auth.organization.listInvitations({
          query: { organizationId: organizationId() },
          fetchOptions: { signal },
        }),
      ),
  });

/** One invitation addressed to the signed-in user, for the accept page. */
export const invitationQuery = (id: string) =>
  queryOptions({
    queryKey: keys.invitation(id),
    queryFn: ({ signal }) =>
      authCall(auth.organization.getInvitation({ query: { id }, fetchOptions: { signal } })),
    retry: false,
  });

export const passkeysQuery = () =>
  queryOptions({
    queryKey: keys.passkeys(),
    queryFn: ({ signal }) => authCall(auth.passkey.listUserPasskeys({ fetchOptions: { signal } })),
  });

export const cancelInvitationMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (invitationId: string) =>
      authCall(auth.organization.cancelInvitation({ invitationId })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.invitations() }),
  });

export const removeMemberMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (memberIdOrEmail: string) =>
      authCall(
        auth.organization.removeMember({ memberIdOrEmail, organizationId: organizationId() }),
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.members() }),
        client.invalidateQueries({ queryKey: keys.workspaceMembers() }),
        client.invalidateQueries({ queryKey: keys.workspaceMailboxes() }),
      ]),
  });

export const updateMemberRoleMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      authCall(
        auth.organization.updateMemberRole({ memberId, role, organizationId: organizationId() }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: keys.members() }),
  });

export const addPasskeyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (name?: string) => authCall(auth.passkey.addPasskey(name ? { name } : {})),
    onSettled: () => client.invalidateQueries({ queryKey: keys.passkeys() }),
  });

export const deletePasskeyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => authCall(auth.passkey.deletePasskey({ id })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.passkeys() }),
  });

/** `mutate({ id, name })` renames one of the user's passkeys. */
export const renamePasskeyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      authCall(auth.passkey.updatePasskey({ id, name })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.passkeys() }),
  });

/** `mutate(invitationId)` sends a pending invitation's email again (through the Worker). */
export const resendInvitationMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (invitationId: string) =>
      call(api.workspace.invitations[":id"].resend.$post({ param: { id: invitationId } })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.invitations() }),
  });

/**
 * `mutate(handle)` changes the active organization's handle (its slug; owners and admins).
 * Better Auth refuses one another workspace already has.
 */
export const changeOrganizationHandleMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (slug: string) =>
      authCall(auth.organization.update({ data: { slug }, organizationId: organizationId() })),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.workspaces() }),
        client.invalidateQueries({ queryKey: keys.organizations() }),
      ]),
  });

/** `mutate(name)` renames the active organization (owners and admins). */
export const renameOrganizationMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (name: string) =>
      authCall(auth.organization.update({ data: { name }, organizationId: organizationId() })),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: keys.workspaces() }),
        client.invalidateQueries({ queryKey: keys.organizations() }),
        client.invalidateQueries({ queryKey: keys.onboarding() }),
      ]),
  });
