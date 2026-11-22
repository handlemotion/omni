import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  reactMutation,
  readThread,
  sendFilesMutation,
  sendNoteMutation,
  talkMessagesQuery,
  talkPeopleQuery,
  talkThreadQuery,
} from "../lib/talk.ts";
import { keepNewestPage } from "../lib/talk-cache.ts";

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

/**
 * `prefetch(person)`: starts loading the thread with them as the pointer reaches their face, so the
 * peek a beat later opens on its notes. A thread loaded in the last minutes is left as it is.
 */
export function usePrefetchThread() {
  const client = useQueryClient();
  return useCallback(
    (person: { threadId: string | null }) => {
      if (person.threadId) void client.prefetchInfiniteQuery(talkMessagesQuery(person.threadId));
    },
    [client],
  );
}

/** The thread's notes while its window is open; closing it keeps only the newest page. */
export function useTalkMessages(threadId: string | undefined) {
  const client = useQueryClient();
  useEffect(() => {
    if (threadId) return () => void keepNewestPage(client, threadId);
  }, [client, threadId]);
  return useInfiniteQuery({ ...talkMessagesQuery(threadId ?? ""), enabled: !!threadId });
}

export function useSendNote(memberId: string, threadId: string | undefined) {
  return useMutation(sendNoteMutation(useQueryClient(), memberId, threadId));
}

export function useSendFiles(memberId: string, threadId: string | undefined) {
  return useMutation(sendFilesMutation(useQueryClient(), memberId, threadId));
}

export function useReact(threadId: string) {
  return useMutation(reactMutation(useQueryClient(), threadId));
}

/** `read(threadId)`: marks the thread read and refreshes the unread counts. */
export function useReadThread() {
  const client = useQueryClient();
  return useCallback((threadId: string) => readThread(client, threadId), [client]);
}
