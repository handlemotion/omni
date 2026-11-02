// Managing the active organization (members, invitations) and the user's passkeys.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addPasskeyMutation,
  cancelInvitationMutation,
  deletePasskeyMutation,
  invitationsQuery,
  inviteMemberMutation,
  membersQuery,
  passkeysQuery,
  removeMemberMutation,
  updateMemberRoleMutation,
} from "../lib/org-queries.ts";

export function useMembers() {
  return useQuery(membersQuery());
}

export function useInvitations() {
  return useQuery(invitationsQuery());
}

/** `mutate({ email, role? })` emails an invitation to `/invite/<id>`. */
export function useInviteMember() {
  return useMutation(inviteMemberMutation(useQueryClient()));
}

/** `mutate(invitationId)`. */
export function useCancelInvitation() {
  return useMutation(cancelInvitationMutation(useQueryClient()));
}

/** `mutate(memberIdOrEmail)`. */
export function useRemoveMember() {
  return useMutation(removeMemberMutation(useQueryClient()));
}

/** `mutate({ memberId, role })`. */
export function useUpdateMemberRole() {
  return useMutation(updateMemberRoleMutation(useQueryClient()));
}

export function usePasskeys() {
  return useQuery(passkeysQuery());
}

/** `mutate(name?)` registers a passkey on this device. */
export function useAddPasskey() {
  return useMutation(addPasskeyMutation(useQueryClient()));
}

/** `mutate(passkeyId)`. */
export function useDeletePasskey() {
  return useMutation(deletePasskeyMutation(useQueryClient()));
}
