// Organizations, members, invitations and passkeys, all through Better Auth's client.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { auth } from "./api.ts";
import { keys } from "./query-keys.ts";
import { authCall } from "./session.ts";

type Role = "member" | "admin" | "owner";

export const organizationsQuery = () =>
  queryOptions({
    queryKey: keys.organizations(),
    queryFn: ({ signal }) => authCall(auth.organization.list({ fetchOptions: { signal } })),
  });

/** Members of the active organization. */
export const membersQuery = () =>
  queryOptions({
    queryKey: keys.members(),
    queryFn: ({ signal }) => authCall(auth.organization.listMembers({ fetchOptions: { signal } })),
  });

/** Invitations sent by the active organization. */
export const invitationsQuery = () =>
  queryOptions({
    queryKey: keys.invitations(),
    queryFn: ({ signal }) =>
      authCall(auth.organization.listInvitations({ fetchOptions: { signal } })),
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

export const inviteMemberMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ email, role = "member" }: { email: string; role?: Role }) =>
      authCall(auth.organization.inviteMember({ email, role })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.invitations() }),
  });

export const cancelInvitationMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (invitationId: string) =>
      authCall(auth.organization.cancelInvitation({ invitationId })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.invitations() }),
  });

export const removeMemberMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (memberIdOrEmail: string) =>
      authCall(auth.organization.removeMember({ memberIdOrEmail })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.members() }),
  });

export const updateMemberRoleMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      authCall(auth.organization.updateMemberRole({ memberId, role })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.members() }),
  });

export const addPasskeyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (name?: string) => authCall(auth.passkey.addPasskey(name ? { name } : {})),
    onSettled: () => client.invalidateQueries({ queryKey: keys.passkeys() }),
  });

export const deletePasskeyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => authCall(auth.passkey.deletePasskey({ id })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.passkeys() }),
  });
