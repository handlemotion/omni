// Internal notes on a helpdesk conversation (ADR 0021): never sent, shown in the timeline to
// everyone who sees the inbox. A note lives in its conversation's `notes`, so each change edits
// that one cache entry at once and puts it back if the request fails.
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { Conversation, Note } from "./types.ts";

/** Marks a note shown before the server answered; its id is not a real note's yet. */
export const PENDING_NOTE_PREFIX = "pending:";

/** Notes go out in the order they were written, behind any conversation change still queued. */
const scope = { id: "mail-actions" };

async function snapshotConversation(client: QueryClient, threadId: string) {
  const key = keys.conversation(threadId);
  await client.cancelQueries({ queryKey: key });
  return client.getQueryData<Conversation>(key);
}

function setNotes(client: QueryClient, threadId: string, fn: (notes: Note[]) => Note[]) {
  client.setQueryData<Conversation>(keys.conversation(threadId), (current) =>
    current ? { ...current, notes: fn(current.notes) } : current,
  );
}

/** Puts the conversation back as it was before the change, if it was loaded. */
function restoreConversation(
  client: QueryClient,
  threadId: string,
  before: Conversation | undefined,
) {
  if (before) client.setQueryData(keys.conversation(threadId), before);
}

export interface AddNoteVariables {
  threadId: string;
  body: string;
  /** `memberId`s of everyone @mentioned (names come from `useAssignees`); each is notified. */
  mentions?: string[];
  /** Your member in the inbox's workspace: the optimistic note's author. */
  authorMemberId?: string | undefined;
  /** Client id for the optimistic entry; set by the hook. */
  localId: string;
}

/**
 * Adds a note: it shows at the end of the timeline at once (id prefixed `pending:`), becomes the
 * server's note when it answers, and goes away if the request fails. Resolves with
 * `{ note, notified }`: `notified` is who got a mention notification.
 */
export const addNoteMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationKey: [...keys.mail(), "note"],
    scope,
    mutationFn: ({ threadId, body, mentions = [] }: AddNoteVariables) =>
      call(api.threads[":id"].notes.$post({ param: { id: threadId }, json: { body, mentions } })),
    onMutate: async ({ threadId, body, mentions = [], authorMemberId, localId }) => {
      const before = await snapshotConversation(client, threadId);
      const now = new Date().toISOString();
      setNotes(client, threadId, (notes) => [
        ...notes,
        {
          id: `${PENDING_NOTE_PREFIX}${localId}`,
          authorMemberId: authorMemberId ?? null,
          body,
          mentions,
          createdAt: now,
          updatedAt: now,
        },
      ]);
      return { before };
    },
    onError: (_error, { threadId, localId }) =>
      setNotes(client, threadId, (notes) =>
        notes.filter((n) => n.id !== `${PENDING_NOTE_PREFIX}${localId}`),
      ),
    onSuccess: ({ note }, { threadId, localId }) =>
      setNotes(client, threadId, (notes) =>
        notes.map((n) => (n.id === `${PENDING_NOTE_PREFIX}${localId}` ? note : n)),
      ),
    // The timeline's note event and the list's activity come from the server.
    onSettled: (_data, _error, { threadId }) =>
      void client.invalidateQueries({ queryKey: keys.thread(threadId) }),
  });

/** The author edits their own note. 404 for anyone else's (or a deleted one). */
export const editNoteMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationKey: [...keys.mail(), "note-edit"],
    scope,
    mutationFn: ({ threadId, noteId, body }: { threadId: string; noteId: string; body: string }) =>
      call(
        api.threads[":id"].notes[":noteId"].$patch({
          param: { id: threadId, noteId },
          json: { body },
        }),
      ),
    onMutate: async ({ threadId, noteId, body }) => {
      const before = await snapshotConversation(client, threadId);
      const now = new Date().toISOString();
      setNotes(client, threadId, (notes) =>
        notes.map((n) => (n.id === noteId ? { ...n, body, updatedAt: now } : n)),
      );
      return { before };
    },
    onError: (_error, { threadId }, context) =>
      restoreConversation(client, threadId, context?.before),
    onSuccess: ({ note }, { threadId }) =>
      setNotes(client, threadId, (notes) =>
        notes.map((n) => (n.id === note.id ? { ...n, ...note } : n)),
      ),
  });

/** The author deletes their own note; its timeline event and notifications go with it. */
export const deleteNoteMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationKey: [...keys.mail(), "note-delete"],
    scope,
    mutationFn: ({ threadId, noteId }: { threadId: string; noteId: string }) =>
      call(api.threads[":id"].notes[":noteId"].$delete({ param: { id: threadId, noteId } })),
    onMutate: async ({ threadId, noteId }) => {
      const before = await snapshotConversation(client, threadId);
      setNotes(client, threadId, (notes) => notes.filter((n) => n.id !== noteId));
      return { before };
    },
    onError: (_error, { threadId }, context) =>
      restoreConversation(client, threadId, context?.before),
    onSettled: (_data, _error, { threadId }) => {
      void client.invalidateQueries({ queryKey: keys.thread(threadId) });
      // A mention notification about it is gone too.
      void client.invalidateQueries({ queryKey: keys.notifications() });
    },
  });
