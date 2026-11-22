import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  reactMutation,
  readThread,
  sendFilesMutation,
  sendNoteMutation,
  talkMessagesQuery,
  talkPeopleQuery,
  talkThreadQuery,
} from "../lib/talk.ts";

/** Your teammates, with who is online and your threads with them. */
export function useTalkPeople() {
  return useQuery(talkPeopleQuery());
}

/**
 * The thread with `person`: the one they already share, read as is; otherwise made on the server
 * only once `make` is true (the window is pinned), so a hover peek never creates one.
 */
export function useTalkThreadId(
  person: { memberId: string; threadId: string | null },
  make: boolean,
) {
  const made = useQuery({ ...talkThreadQuery(person.memberId), enabled: make && !person.threadId });
  return person.threadId ?? made.data?.id;
}

export function useTalkMessages(threadId: string | undefined) {
  return useInfiniteQuery({ ...talkMessagesQuery(threadId ?? ""), enabled: !!threadId });
}

export function useSendNote(threadId: string | undefined) {
  return useMutation(sendNoteMutation(useQueryClient(), threadId));
}

export function useSendFiles(threadId: string | undefined) {
  return useMutation(sendFilesMutation(useQueryClient(), threadId));
}

export function useReact(threadId: string) {
  return useMutation(reactMutation(useQueryClient(), threadId));
}

/** `read(threadId)`: marks the thread read and refreshes the unread counts. */
export function useReadThread() {
  const client = useQueryClient();
  return useCallback((threadId: string) => readThread(client, threadId), [client]);
}
