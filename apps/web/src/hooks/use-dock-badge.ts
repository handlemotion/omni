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
  useEffect(
    () => () => {
      if (desktop.isDesktop) desktop.setBadge(0);
    },
    [],
  );
}
