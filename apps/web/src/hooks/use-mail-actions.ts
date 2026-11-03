// Changing mail. Every action updates the screen at once and undoes itself if the request fails;
// the outbox then carries it out on IMAP/SMTP. Call `mutate({ ... })` without a key: one is made
// per call.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import {
  archiveMutation,
  deferMutation,
  doneMutation,
  markReadMutation,
  moveMutation,
  replyMutation,
  sendMutation,
  undoneMutation,
} from "../lib/mail-mutations.ts";
import { dismissFailure, removePending, type ActionFailure } from "../lib/pending.ts";
import { keys } from "../lib/query-keys.ts";
import { useKeyedMutation } from "./keyed-mutation.ts";

/** `mutate({ threadId, read })`. On a shared mailbox, read state is yours alone. */
export function useMarkRead() {
  return useKeyedMutation(markReadMutation(useQueryClient()));
}

/** `mutate({ threadId, until })` puts it in your Queue; `until: null` brings it back now. */
export function useDefer() {
  return useKeyedMutation(deferMutation(useQueryClient()));
}

/**
 * `mutate({ threadId, through: thread.lastMessageAt })`. Done for you alone; a newer message
 * brings it back to the Inbox.
 */
export function useMarkDone() {
  return useKeyedMutation(doneMutation(useQueryClient()));
}

/** `mutate({ threadId })`: not done, back in the Inbox. */
export function useMarkUndone() {
  return useKeyedMutation(undoneMutation(useQueryClient()));
}

/** `mutate({ threadId })`. */
export function useArchive() {
  return useKeyedMutation(archiveMutation(useQueryClient()));
}

/** `mutate({ threadId, destination })`, where `destination` is an IMAP folder path. */
export function useMove() {
  return useKeyedMutation(moveMutation(useQueryClient()));
}

/**
 * `mutate({ threadId, text, html?, replyAll? })`. The reply appears in `useThread(...).pending`
 * immediately and is replaced by the real message when it arrives.
 */
export function useSendReply() {
  return useKeyedMutation(replyMutation(useQueryClient()));
}

/** `mutate({ mailboxId, to, cc?, bcc?, subject, text, html? })` for a new message. */
export function useSend() {
  return useKeyedMutation(sendMutation(useQueryClient()));
}

/**
 * Marks the thread read once when it is opened unread. Opening it again after marking it
 * unread by hand does not fight the user: it runs once per thread id per mount.
 */
export function useMarkReadOnOpen(thread: { id: string; read: boolean } | undefined) {
  const { mutate } = useMarkRead();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!thread || done.current === thread.id) return;
    done.current = thread.id;
    if (!thread.read) mutate({ threadId: thread.id, read: true });
  }, [thread, mutate]);
}

/** Drops a failed pending reply from the thread (e.g. after the user copied the text). */
export function useDiscardPending() {
  const client = useQueryClient();
  return useCallback(
    (threadId: string, key: string) => removePending(client, threadId, key),
    [client],
  );
}

/**
 * Outbox actions that failed for good and are not shown on a pending reply (a new message that
 * could not be sent, an archive that did not reach the server). Dismiss each once shown.
 */
export function useActionFailures() {
  const client = useQueryClient();
  const failures =
    useQuery({
      queryKey: keys.failures(),
      queryFn: () => [] as ActionFailure[],
      initialData: [] as ActionFailure[],
    }).data ?? [];
  const dismiss = useCallback((actionId: string) => dismissFailure(client, actionId), [client]);
  return { failures, dismiss };
}
