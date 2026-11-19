import type { Thread } from "@omni/client";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  leavesPage,
  useArchive,
  useDone,
  useLater,
  useMarkUnread,
  useSpam,
  useTrash,
  useUndone,
  useUnsubscribe,
  type ThreadAction,
} from "@/lib/thread-actions.ts";

type Message = Thread["messages"][number];
export type ListMessage = Message & { unsubscribe: NonNullable<Message["unsubscribe"]> };

/** The newest message that came from a mailing list, to leave it. */
export function listMessage(thread: Thread) {
  return thread.messages.findLast((m): m is ListMessage => !!m.unsubscribe);
}

/** Writing back: a reply to the thread, to everyone on it with `all`. */
export const reply = (threadId: string, all: boolean) =>
  router.push({ pathname: "/mail/compose", params: { threadId, ...(all ? { all: "1" } : {}) } });

/** Passing the conversation's latest message on, in the composer's forward mode. */
export const forward = (threadId: string) =>
  router.push({ pathname: "/mail/compose", params: { threadId, forward: "1" } });

/**
 * The conversation's actions, as the web reader's. One that takes the thread out of the list it
 * was opened from (`page`, the route's param) goes back to that list.
 */
export function useThreadActions(page: string | undefined) {
  const done = useDone();
  const undone = useUndone();
  const later = useLater();
  const archive = useArchive();
  const markUnread = useMarkUnread();
  const spam = useSpam();
  const trash = useTrash();
  const unsubscribe = useUnsubscribe();
  const run = (action: ThreadAction, mutate: () => void) => {
    mutate();
    if (leavesPage(action, page) && router.canGoBack()) router.back();
  };
  return {
    markUnread,
    unsubscribe,
    toggleDone: (thread: Thread) =>
      thread.done
        ? run("undone", () => undone.mutate({ threadId: thread.id }))
        : run("done", () => done.mutate({ threadId: thread.id, through: thread.lastMessageAt })),
    later: (threadId: string, into: boolean, until?: Date) =>
      run(into ? "later" : "unlater", () =>
        later.mutate({ threadId, later: into, ...(until ? { until } : {}) }),
      ),
    swipeAway: (thread: Thread, into: "done" | "later") => {
      if (into === "done") done.mutate({ threadId: thread.id, through: thread.lastMessageAt });
      else later.mutate({ threadId: thread.id, later: true });
      if (router.canGoBack()) router.back();
    },
    archive: (threadId: string) => run("archive", () => archive.mutate({ threadId })),
    spam: (threadId: string, into: boolean) =>
      run(into ? "spam" : "notSpam", () => spam.mutate({ threadId, spam: into })),
    trash: (threadId: string) => run("trash", () => trash.mutate({ threadId })),
    leaveList: (threadId: string, message: ListMessage) => {
      if (message.unsubscribe.url) void WebBrowser.openBrowserAsync(message.unsubscribe.url);
      else unsubscribe.mutate({ threadId, messageId: message.id });
    },
  };
}

export type ThreadActions = ReturnType<typeof useThreadActions>;
