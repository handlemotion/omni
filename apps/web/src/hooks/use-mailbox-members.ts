// Who can see a shared mailbox (ADR 0008). Owners and admins add and remove members; the
// candidates are `useMembers()` (the organization). A personal mailbox answers 404.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMailboxMemberMutation,
  mailboxMembersQuery,
  removeMailboxMemberMutation,
} from "../lib/mailbox-members.ts";

export function useMailboxMembers(mailboxId: string) {
  return useQuery(mailboxMembersQuery(mailboxId));
}

/** `mutate({ mailboxId, memberId })` gives that member access to the shared mailbox. */
export function useAddMailboxMember() {
  return useMutation(addMailboxMemberMutation(useQueryClient()));
}

/** `mutate({ mailboxId, memberId })` takes their access away. */
export function useRemoveMailboxMember() {
  return useMutation(removeMailboxMemberMutation(useQueryClient()));
}
