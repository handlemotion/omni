// Shows new mail and your notifications, from every workspace you're in, as system notifications
// when this device has them on (Settings → Notifications). Mount once, in the signed-in shell.
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useDesktopNotificationState } from "../lib/desktop-notifications.ts";
import { watchWorkspaces, type WatchTarget } from "../lib/workspace-watch.ts";
import { openNotificationsPanel } from "./use-notifications-panel.ts";
import { useWorkspaces } from "./use-workspaces.ts";

export {
  setDesktopNotifications,
  useDesktopNotificationState,
} from "../lib/desktop-notifications.ts";

export function useDesktopNotifications() {
  const on = useDesktopNotificationState() === "on";
  const client = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useWorkspaces({ enabled: on }).data?.workspaces;
  const latest = useRef(workspaces);
  latest.current = workspaces;
  // A string, so a refetched list with the same workspaces leaves the sockets alone.
  const ids = (workspaces ?? [])
    .map((w) => w.id)
    .toSorted()
    .join(",");

  useEffect(() => {
    if (!on || !ids) return;
    const find = (orgId: string) => latest.current?.find((w) => w.id === orgId);
    const open = ({ orgId, threadId, panel }: WatchTarget) => {
      const workspace = find(orgId)?.slug;
      if (!workspace) return;
      if (threadId) {
        void navigate({ to: "/$workspace/mail/inbox/$threadId", params: { workspace, threadId } });
        return;
      }
      void navigate({ to: "/$workspace/mail/inbox", params: { workspace } });
      if (panel) openNotificationsPanel();
    };
    return watchWorkspaces(client, ids.split(","), { nameOf: (id) => find(id)?.name, open });
  }, [on, ids, client, navigate]);
}
