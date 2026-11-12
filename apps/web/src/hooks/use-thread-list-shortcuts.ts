// The thread list's keys (`j`/`k`, `o`, `x`, `e`, `h`, `u`, `z`, Esc). The cursor is the focused row:
// moving it moves real focus, so React Aria and screen readers follow it.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type RefObject } from "react";
import type { Selection } from "react-aria-components";
import { DEFER_MS, isDeferred, leavesView } from "../lib/threads.ts";
import type { ThreadSummary, ThreadView } from "../lib/types.ts";
import { offerUndo } from "../lib/undo.ts";
import { usePrefetchThread } from "./use-mail.ts";
import { useDefer, useMarkDone, useMarkRead, useMarkUndone } from "./use-mail-actions.ts";
import { announce, useShortcut } from "./use-shortcuts.ts";
import { useUndo } from "./use-undo.ts";

const plural = (n: number) => (n === 1 ? "Thread" : `${n} threads`);

export function useThreadListShortcuts(options: {
  view: ThreadView;
  threads: ThreadSummary[];
  /** The open thread, if any. */
  threadId: string | undefined;
  href: (threadId: string) => string;
  selected: Selection;
  setSelected: (selection: Selection) => void;
  /** The GridList element; rows carry `data-key`. */
  listRef: RefObject<HTMLElement | null>;
  /** List view with a thread open: the list is hidden, so j/k open the neighbour. */
  listHidden: boolean;
  loadMore?: (() => void) | undefined;
}) {
  const { view, threads, threadId, href, selected, setSelected, listRef, listHidden } = options;
  const navigate = useNavigate();
  const location = useLocation();
  const markRead = useMarkRead();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  const defer = useDefer();
  const prefetch = usePrefetchThread();
  // Binds `z` to the standing undo offer wherever the list is, toast or not.
  useUndo();
  // The last row that had focus, so the cursor survives focus moving to the thread pane.
  const cursorRef = useRef<string | null>(null);
  const ids = threads.map((t) => t.id);

  // Arrow keys and clicks move focus through React Aria, not us: follow them.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const follow = (event: FocusEvent) => {
      const key = (event.target as Element | null)?.closest("[data-key]")?.getAttribute("data-key");
      if (key) cursorRef.current = key;
    };
    list.addEventListener("focusin", follow);
    return () => list.removeEventListener("focusin", follow);
  }, [listRef]);

  const cursor = () => {
    const focused = document.activeElement?.closest("[data-key]")?.getAttribute("data-key");
    for (const id of [focused, cursorRef.current, threadId]) if (id && ids.includes(id)) return id;
    return null;
  };

  const focusRow = (id: string) => {
    cursorRef.current = id;
    const row = () => listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(id)}"]`);
    const found = row();
    if (found) return found.focus();
    // The list is virtualized: only rows near the viewport are in the DOM. Scroll this one's
    // position into view (rows share one height), then focus it once it has rendered.
    const grid = listRef.current?.querySelector<HTMLElement>('[role="grid"]');
    const height = grid?.querySelector("[data-key]")?.getBoundingClientRect().height;
    const at = ids.indexOf(id);
    if (!grid || !height || at === -1) return;
    grid.scrollTop = at * height - (grid.clientHeight - height) / 2;
    requestAnimationFrame(() => requestAnimationFrame(() => row()?.focus()));
  };

  const open = (id: string) => void navigate({ href: href(id) });

  /** Back to the list: the thread route's parent, same search. */
  const close = () => {
    const path = location.pathname.slice(0, location.pathname.lastIndexOf("/"));
    void navigate({ href: path + location.searchStr });
  };

  const move = (delta: 1 | -1) => {
    const at = ids.indexOf(cursor() ?? "");
    const next = at === -1 ? 0 : at + delta;
    if (next >= ids.length) options.loadMore?.();
    const id = ids[Math.max(0, Math.min(ids.length - 1, next))];
    if (!id) return;
    // Warm the row landed on and the one after it, so opening (or the next j/k with the list
    // hidden) renders from cache.
    prefetch(id);
    const ahead = ids[next + delta];
    if (ahead) prefetch(ahead);
    if (listHidden) open(id);
    else focusRow(id);
  };

  /** The selected threads, or else the one under the cursor. */
  const targets = () => {
    if (selected === "all") return threads;
    if (selected.size) return threads.filter((t) => selected.has(t.id));
    const id = cursor();
    return threads.filter((t) => t.id === id);
  };

  /**
   * Runs an action on the targets. Threads it takes out of this view (`leaves`) move the cursor
   * to the nearest row that stays, and the open thread to that row (or closed).
   */
  const act = (
    run: (t: ThreadSummary) => void,
    leaves: (t: ThreadSummary) => boolean,
    said: (n: number) => string,
    inverse?: (t: ThreadSummary) => void,
  ) => {
    const list = targets();
    if (!list.length) return;
    const gone = new Set(list.filter(leaves).map((t) => t.id));
    const at = ids.indexOf(cursor() ?? "");
    const stays = (id: string | undefined) => !!id && !gone.has(id);
    const neighbour =
      ids.slice(at + 1).find(stays) ?? ids.slice(0, Math.max(at, 0)).findLast(stays);
    const hadFocus = !!listRef.current?.contains(document.activeElement);
    list.forEach(run);
    setSelected(new Set());
    announce(said(list.length));
    if (inverse) offerUndo(said(list.length), () => list.forEach(inverse));
    const current = cursor();
    if (current && gone.has(current) && neighbour) {
      cursorRef.current = neighbour;
      if (hadFocus) requestAnimationFrame(() => focusRow(neighbour));
    }
    if (threadId && gone.has(threadId)) {
      if (neighbour) open(neighbour);
      else close();
    }
  };

  /**
   * Undo: puts each thread back as it was before `applied`, from its own row as it was (a
   * selection can mix done, deferred and plain threads). Done clears a deferral and defer clears
   * done on the server, so the earlier state is set again rather than the action reversed.
   */
  const restore = (applied: "done" | "undone" | "defer" | "undefer") => (t: ThreadSummary) => {
    if (t.done) {
      if (applied !== "done") markDone.mutate({ threadId: t.id, through: t.lastMessageAt });
    } else if (isDeferred(t.deferredUntil)) {
      defer.mutate({ threadId: t.id, until: new Date(t.deferredUntil as string) });
    } else if (applied === "done") {
      markUndone.mutate({ threadId: t.id });
    } else if (applied === "defer") {
      defer.mutate({ threadId: t.id, until: null });
    }
  };

  const has = threads.length > 0;
  useShortcut("next", () => move(1), has);
  useShortcut("previous", () => move(-1), has);
  useShortcut(
    "open",
    () => {
      const id = cursor();
      if (id) open(id);
    },
    has,
  );
  useShortcut(
    "select",
    () => {
      const id = cursor();
      if (!id) return;
      const next = new Set(selected === "all" ? ids : selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
    },
    has,
  );
  useShortcut(
    "done",
    () => {
      const undo = targets().every((t) => t.done);
      act(
        (t) =>
          undo
            ? markUndone.mutate({ threadId: t.id })
            : markDone.mutate({ threadId: t.id, through: t.lastMessageAt }),
        () => leavesView(undo ? "undone" : "done", view),
        (n) => `${plural(n)} ${undo ? "back in the Inbox" : "marked done"}`,
        restore(undo ? "undone" : "done"),
      );
    },
    has,
  );
  useShortcut(
    "defer",
    () => {
      const back = targets().every((t) => isDeferred(t.deferredUntil));
      const until = back ? null : new Date(Date.now() + DEFER_MS);
      act(
        (t) => defer.mutate({ threadId: t.id, until }),
        () => leavesView(back ? "undefer" : "defer", view),
        (n) => `${plural(n)} ${back ? "back in the Inbox" : "deferred until tomorrow"}`,
        restore(back ? "undefer" : "defer"),
      );
    },
    has,
  );
  useShortcut(
    "read",
    () => {
      const read = targets().some((t) => t.unread);
      act(
        (t) => markRead.mutate({ threadId: t.id, read }),
        () => false,
        (n) => `${plural(n)} marked ${read ? "read" : "unread"}`,
      );
    },
    has,
  );
  useShortcut("close", close, !!threadId);
}
