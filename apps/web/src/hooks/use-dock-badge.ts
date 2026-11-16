// The desktop app's Dock badge shows the inbox's unread count (docs/spec/desktop.md, "The shell"),
// the same number as the sidebar's Inbox row. Mount once, in the signed-in shell; does nothing in
// a browser.
import { useEffect } from "react";
import { desktop } from "../lib/desktop.ts";
import { useCounts } from "./use-mail.ts";

export function useDockBadge() {
  const counts = useCounts().data?.counts;
  const unread = counts?.reduce((sum, c) => sum + c.unread, 0);
  useEffect(() => {
    if (!desktop.isDesktop || unread === undefined) return;
    desktop.setBadge(unread);
  }, [unread]);
  // Signing out or leaving the shell clears it: a stale count would outlive the session.
  useEffect(
    () => () => {
      if (desktop.isDesktop) desktop.setBadge(0);
    },
    [],
  );
}
