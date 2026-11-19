import { Stack, router } from "expo-router";
import { useState } from "react";
import { IconInbox } from "@/components/icons.ts";
import { NotificationRow } from "@/components/notifications/notification-row.tsx";
import { InfiniteList } from "@/components/ui/infinite-list.tsx";
import { commentTarget, type Notification } from "@/lib/notification-text.ts";
import {
  useMarkNotificationsRead,
  useNotifications,
  useUnreadNotifications,
} from "@/lib/notifications.ts";
import { currentWorkspaceId } from "@/lib/workspace-id.ts";

function open(n: Notification) {
  const comment = commentTarget(n);
  if (comment) {
    router.push({
      pathname: "/drive/file/[id]",
      params: { id: comment.nodeId, name: comment.nodeName },
    });
    return;
  }
  if (n.threadId) router.push({ pathname: "/mail/thread/[id]", params: { id: n.threadId } });
}

/** Your notifications, newest first: All or Unread, Mark all read, and a tap opens one. */
export default function Notifications() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useNotifications(unreadOnly);
  const unread = useUnreadNotifications();
  const markRead = useMarkNotificationsRead();
  return (
    <>
      <Stack.Screen options={{ title: "Notifications" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="envelope.open"
          accessibilityLabel="Mark all read"
          disabled={unread === 0}
          onPress={() => markRead.mutate({ workspace: currentWorkspaceId() })}
        />
        <Stack.Toolbar.Menu
          icon="line.3.horizontal.decrease"
          accessibilityLabel={unreadOnly ? "Show, Unread" : "Show, All"}
        >
          <Stack.Toolbar.MenuAction isOn={!unreadOnly} onPress={() => setUnreadOnly(false)}>
            All
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction isOn={unreadOnly} onPress={() => setUnreadOnly(true)}>
            {unread ? `Unread (${unread})` : "Unread"}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <InfiniteList
        query={list}
        keyOf={(n) => n.id}
        icon={IconInbox}
        empty="No notifications"
        renderItem={(n) => (
          <NotificationRow
            n={n}
            onPress={() => {
              if (!n.readAt) markRead.mutate({ ids: [n.id], workspace: currentWorkspaceId() });
              open(n);
            }}
          />
        )}
      />
    </>
  );
}
