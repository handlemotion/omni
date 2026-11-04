// Who can see a shared mailbox (ADR 0008). Owners and admins add and remove members; the
// candidates are `useMembers()` (the organization). A personal mailbox answers 404.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMailboxMemberMutation,
  mailboxMembersQuery,
  removeMailboxMemberMutation,
  workspaceMailboxesQuery,
} from "../lib/mailbox-members.ts";

/** Every mailbox of the workspace, without its mail. Pass `enabled: false` for non-managers (403). */
export function useWorkspaceMailboxes(enabled = true) {
  return useQuery({ ...workspaceMailboxesQuery(), enabled });
}

/** `enabled: false` when the count is already known, or the mailbox isn't a shared one. */
export function useMailboxMembers(mailboxId: string, enabled = true) {
  return useQuery({ ...mailboxMembersQuery(mailboxId), enabled });
}

/** `mutate({ mailboxId, memberId })` gives that member access to the shared mailbox. */
export function useAddMailboxMember() {
  return useMutation(addMailboxMemberMutation(useQueryClient()));
}

/** `mutate({ mailboxId, memberId })` takes their access away. */
export function useRemoveMailboxMember() {
  return useMutation(removeMailboxMemberMutation(useQueryClient()));
}
