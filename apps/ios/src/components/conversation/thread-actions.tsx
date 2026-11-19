import type { Thread } from "@omni/client";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { canReplyAll } from "@/lib/compose.ts";
import { useThread } from "@/lib/mail.ts";
import {
  leavesPage,
  snoozePresets,
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

/**
 * The conversation's header actions, as the web reader's: Reply and Done (or Not done) as
 * buttons, Reply all and the rest in a native menu. An action that takes the thread out of the list it was opened from goes
 * back to that list, which the route names in its `page` param.
 *
 * Native header items are read from the element tree, so every button, menu and action here is a
 * direct `Stack.Toolbar.*` element: no wrapper components, no fragments.
 */
export function ThreadActions({ threadId }: { threadId: string }) {
  const { page } = useLocalSearchParams<{ page?: string }>();
  const thread = useThread(threadId).data;
  const act = useActions(page);
  if (!thread) return null;
  const inSpam = page === "spam";
  const list = listMessage(thread);
  const unsubscribed = act.unsubscribe.isSuccess || !!list?.unsubscribe.unsubscribed;
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button
        icon="arrowshape.turn.up.left"
        accessibilityLabel="Reply"
        onPress={() => reply(threadId, false)}
      />
      <Stack.Toolbar.Button
        icon={thread.done ? "tray" : "checkmark"}
        accessibilityLabel={thread.done ? "Not done" : "Done"}
        onPress={() => act.toggleDone(thread)}
      />
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Thread actions">
        <Stack.Toolbar.Menu inline>
          <Stack.Toolbar.MenuAction
            icon="arrowshape.turn.up.left.2"
            hidden={!canReplyAll(thread)}
            onPress={() => reply(threadId, true)}
          >
            Reply all
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Menu inline>
          <Stack.Toolbar.MenuAction
            icon="tray"
            hidden={!thread.later}
            onPress={() => act.later(threadId, false)}
          >
            Back to inbox
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="clock"
            hidden={thread.later}
            onPress={() => act.later(threadId, true)}
          >
            Later
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu title="Snooze" icon="moon.zzz" hidden={thread.later}>
            {snoozePresets().map((preset) => (
              <Stack.Toolbar.MenuAction
                key={preset.id}
                onPress={() => act.later(threadId, true, preset.until)}
              >
                {preset.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction
            icon="archivebox"
            hidden={thread.archived}
            onPress={() => act.archive(threadId)}
          >
            Archive
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon={thread.read ? "envelope.badge" : "envelope.open"}
            onPress={() => act.markUnread.mutate({ threadId, read: !thread.read })}
          >
            {thread.read ? "Mark unread" : "Mark read"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Menu inline>
          <Stack.Toolbar.MenuAction
            icon="bell.slash"
            hidden={!list}
            destructive={!unsubscribed}
            disabled={unsubscribed || act.unsubscribe.isPending}
            onPress={() => list && act.leaveList(threadId, list)}
          >
            {unsubscribed ? "Unsubscribed" : "Unsubscribe"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon={inSpam ? "tray.and.arrow.down" : "exclamationmark.triangle"}
            onPress={() => act.spam(threadId, !inSpam)}
          >
            {inSpam ? "Not spam" : "Move to spam"}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="trash"
            destructive
            hidden={page === "trash"}
            onPress={() => act.trash(threadId)}
          >
            Move to trash
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}

const reply = (threadId: string, all: boolean) =>
  router.push({ pathname: "/mail/compose", params: { threadId, ...(all ? { all: "1" } : {}) } });

type Message = Thread["messages"][number];
type ListMessage = Message & { unsubscribe: NonNullable<Message["unsubscribe"]> };

function listMessage(thread: Thread) {
  return thread.messages.findLast((m): m is ListMessage => !!m.unsubscribe);
}

function useActions(page: string | undefined) {
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
