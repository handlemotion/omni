import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { currentWorkspaceId } from "@/lib/current-workspace.ts";
import {
  desktopNotificationsOn,
  inBackground,
  showNotification,
} from "@/lib/desktop-notifications.ts";
import { keys } from "@/lib/query-keys.ts";
import { onTalkMessage } from "@/lib/realtime.ts";
import type { TalkPerson } from "@/lib/talk.ts";
import { talkWindow } from "@/lib/talk-window.ts";

/**
 * A teammate's note that arrives while its window is closed, or Omni is in the background, shows
 * a system notification (when they are on for this device). Clicking it goes back to the
 * workspace it came from, if you have moved on, and opens the window there.
 */
export function useTalkNotifications(meId: string) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useWorkspaces().data?.workspaces;
  const latest = useRef(workspaces);
  latest.current = workspaces;
  useEffect(
    () =>
      onTalkMessage((event) => {
        if (event.fromMemberId === meId) return;
        const looking = talkWindow.get() === event.fromMemberId && !inBackground();
        if (looking || !desktopNotificationsOn()) return;
        const orgId = currentWorkspaceId();
        const people = client.getQueryData<TalkPerson[]>(keys.talkPeople());
        const from = people?.find((p) => p.memberId === event.fromMemberId);
        showNotification(
          { tag: `talk:${event.messageId}`, title: from?.name ?? "Omni", body: event.preview },
          () => {
            const slug = latest.current?.find((w) => w.id === orgId)?.slug;
            if (orgId !== currentWorkspaceId() && slug) {
              void navigate({ to: "/$workspace/mail/inbox", params: { workspace: slug } });
            }
            talkWindow.open(event.fromMemberId);
          },
        );
      }),
    [client, meId, navigate],
  );
}
