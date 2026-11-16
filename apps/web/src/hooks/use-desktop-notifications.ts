// Shows new helpdesk notifications as system notifications while Omni is in the background, when
// this device has them on (Settings → Notifications). Mount once, in the signed-in shell.
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { createNotifier, useDesktopNotificationState } from "../lib/desktop-notifications.ts";
import { notificationsQuery } from "../lib/notifications.ts";
import { openNotificationsPanel } from "./use-notifications-panel.ts";

export {
  setDesktopNotifications,
  useDesktopNotificationState,
} from "../lib/desktop-notifications.ts";
import { useWorkspaceSlug } from "./use-workspaces.ts";

export function useDesktopNotifications() {
  const on = useDesktopNotificationState() === "on";
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  // The unread list refetches when the realtime socket says one arrived.
  const unread = useInfiniteQuery({ ...notificationsQuery({ unread: true }), enabled: on });
  const notify = useMemo(
    () =>
      createNotifier((notice) => {
        if (notice.threadId)
          void navigate({
            to: "/$workspace/mail/inbox/$threadId",
            params: { workspace, threadId: notice.threadId },
          });
        else openNotificationsPanel();
      }),
    [navigate],
  );
  const first = unread.data?.pages[0]?.notifications;
  useEffect(() => {
    if (first) notify(first);
  }, [first, notify]);
}
