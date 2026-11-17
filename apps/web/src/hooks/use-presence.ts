import { useEffect, useRef, useSyncExternalStore } from "react";
import { presenceStore, REPEAT_MS, type Presence } from "../lib/presence.ts";
import { onRealtimeOpen, sendRealtime } from "../lib/realtime.ts";
import { useAllMailboxes } from "./use-mail.ts";

/**
 * Teammates viewing or replying in this conversation, oldest first. Includes your own member
 * when you have it open in another tab; filter by `member.id` to show only others.
 */
export function usePresence(threadId: string) {
  return useSyncExternalStore(
    presenceStore.subscribe,
    () => presenceStore.get(threadId),
    () => presenceStore.get(threadId),
  ) satisfies readonly Presence[];
}

/**
 * Tells the conversation's teammates you are here while mounted: `viewing` in the reader,
 * `replying` while the composer has text. Repeats so it outlives a missed event, says it again
 * after a reconnect, and says `left` on unmount. `state: null` reports nothing.
 */
export function useReportPresence(
  thread: { id: string; mailboxId: string } | undefined,
  state: "viewing" | "replying" | null,
) {
  const orgId = useAllMailboxes().data?.find((m) => m.id === thread?.mailboxId)?.orgId;
  const threadId = thread?.id;
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  useEffect(() => {
    if (!orgId || !threadId) return;
    const say = () => {
      const now = latest.current;
      if (now) sendRealtime(orgId, { type: "presence", threadId, state: now });
    };
    const repeat = setInterval(say, REPEAT_MS);
    const stopListening = onRealtimeOpen((opened) => opened === orgId && say());
    return () => {
      clearInterval(repeat);
      stopListening();
      sendRealtime(orgId, { type: "presence", threadId, state: "left" });
    };
  }, [orgId, threadId]);

  useEffect(() => {
    if (!orgId || !threadId) return;
    sendRealtime(orgId, { type: "presence", threadId, state: state ?? "left" });
  }, [orgId, threadId, state]);
}
