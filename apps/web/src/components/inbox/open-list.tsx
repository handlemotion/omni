import { useNavigate } from "@tanstack/react-router";
import { createContext, use } from "react";
import type { ThreadView } from "@/lib/types.ts";
import { leavesView } from "@/lib/threads.ts";
import type { ListRow } from "./thread-list.tsx";

/** The rows of the list an open thread came from, and where each opens. */
export interface OpenList {
  rows: ListRow[];
  href: (threadId: string) => string;
  /** The list alone, with no thread open. */
  closeHref: string | undefined;
  /** The view the rows are from, when Done and Later can take a row out of it. */
  view: ThreadView | undefined;
}

export const OpenListContext = createContext<OpenList | null>(null);

/** The list behind the open thread, so it can be switched without the list on screen. */
export const useOpenList = () => use(OpenListContext);

/**
 * Call before an action on the open thread: when it takes the thread out of the list, the next
 * row opens (the previous one at the end), or the list closes the pane when none is left. The
 * same as the list's own `e` and `h`.
 */
export function useLeaveOpenThread() {
  const list = useOpenList();
  const navigate = useNavigate();
  return (threadId: string, action: Parameters<typeof leavesView>[0]) => {
    if (!list || !leavesView(action, list.view)) return;
    const ids = list.rows.map((r) => r.id);
    const at = ids.indexOf(threadId);
    if (at === -1) return;
    const neighbour = ids[at + 1] ?? ids[at - 1];
    const href = neighbour ? list.href(neighbour) : list.closeHref;
    if (href) void navigate({ href });
  };
}
