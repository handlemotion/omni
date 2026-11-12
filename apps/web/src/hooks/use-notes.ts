// Internal notes on a helpdesk conversation. Each change shows at once and rolls back if the
// request fails. Read notes from `useConversation(threadId).data.notes`.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { memberInInbox } from "../lib/conversations.ts";
import {
  addNoteMutation,
  deleteNoteMutation,
  editNoteMutation,
  PENDING_NOTE_PREFIX,
} from "../lib/notes.ts";
import { keys } from "../lib/query-keys.ts";
import type { Conversation, Note } from "../lib/types.ts";
import { useSession } from "./use-session.ts";

/** True while a note is shown but not yet saved: it cannot be edited or deleted yet. */
export const isPendingNote = (note: Pick<Note, "id">) => note.id.startsWith(PENDING_NOTE_PREFIX);

/**
 * `mutate({ threadId, body, mentions? })`: adds an internal note, shown at the end of the
 * conversation's `notes` at once. `mentions` are `memberId`s from `useAssignees`; each is
 * notified. Resolves with `{ note, notified }`.
 */
export function useAddNote() {
  const client = useQueryClient();
  const email = useSession().data?.user.email;
  const mutation = useMutation(addNoteMutation(client));
  const withAuthor = (vars: { threadId: string; body: string; mentions?: string[] }) => {
    const mailboxId = client.getQueryData<Conversation>(
      keys.conversation(vars.threadId),
    )?.mailboxId;
    return {
      ...vars,
      authorMemberId: memberInInbox(client, mailboxId, email),
      localId: crypto.randomUUID(),
    };
  };
  return {
    ...mutation,
    mutate: (vars: { threadId: string; body: string; mentions?: string[] }) =>
      mutation.mutate(withAuthor(vars)),
    mutateAsync: (vars: { threadId: string; body: string; mentions?: string[] }) =>
      mutation.mutateAsync(withAuthor(vars)),
  };
}

/** `mutate({ threadId, noteId, body })`: the author edits their own note. */
export function useEditNote() {
  return useMutation(editNoteMutation(useQueryClient()));
}

/** `mutate({ threadId, noteId })`: the author deletes their own note. */
export function useDeleteNote() {
  return useMutation(deleteNoteMutation(useQueryClient()));
}
