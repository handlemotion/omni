// The workspace admin surface for inboxes (ADR 0026), for owners and admins.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSharedInboxMutation,
  giveInboxMutation,
  inviteWithInboxMutation,
  issueInboxMutation,
  removeInboxMutation,
  shareInboxMutation,
  workspaceMembersQuery,
} from "../lib/workspace-admin.ts";

/** Every member with the inboxes each can open. Pass `enabled: false` for non-managers (403). */
export function useWorkspaceMembers(enabled = true) {
  return useQuery({ ...workspaceMembersQuery(), enabled });
}

export function useIssueInbox() {
  return useMutation(issueInboxMutation(useQueryClient()));
}

export function useCreateSharedInbox() {
  return useMutation(createSharedInboxMutation(useQueryClient()));
}

export function useGiveInbox() {
  return useMutation(giveInboxMutation(useQueryClient()));
}

export function useShareInbox() {
  return useMutation(shareInboxMutation(useQueryClient()));
}

export function useRemoveInbox() {
  return useMutation(removeInboxMutation(useQueryClient()));
}

export function useInviteWithInbox() {
  return useMutation(inviteWithInboxMutation(useQueryClient()));
}
