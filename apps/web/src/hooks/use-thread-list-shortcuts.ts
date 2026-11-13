// The thread list's keys (`j`/`k`, `o`, `x`, `e`, `h`, `u`, `z`, Esc; on a helpdesk list `e`
// resolves, `h` snoozes and `i` assigns to you). The cursor is the focused row:
// moving it moves real focus, so React Aria and screen readers follow it.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type RefObject } from "react";
import type { Selection } from "react-aria-components";
import { applyChange, inView, type ConversationChange } from "../lib/conversations.ts";
import { leavesView } from "../lib/threads.ts";
import type {
  ConversationFilter,
  ConversationSummary,
  ThreadSummary,
  ThreadView,
} from "../lib/types.ts";
import { offerUndo } from "../lib/undo.ts";
import { useBulkChange } from "./use-conversation.ts";
import { usePrefetchThread } from "./use-mail.ts";
import { useMarkDone, useMarkRead, useMarkUndone, useMoveToLater } from "./use-mail-actions.ts";
import { announce, useShortcut } from "./use-shortcuts.ts";
import { useUndo } from "./use-undo.ts";

/** A per-row action as an action on a list of rows. */
const each =
  <T>(run: (t: T) => void) =>
  (list: T[]) =>
    list.forEach(run);

const plural = (n: number) => (n === 1 ? "Thread" : `${n} threads`);

/** How long `h` snoozes a helpdesk conversation for the team: a day. */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

export function useThreadListShortcuts(options: {
  view: ThreadView;
  threads: ThreadSummary[];
  /**
   * A helpdesk list (`useConversations(filter)`): pass its filter and rows here, and `e`, `h`
   * and `i` resolve, snooze and assign to you instead of done and later. `threads` is ignored.
   */
  helpdesk?: { filter: ConversationFilter; conversations: ConversationSummary[] } | undefined;
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
  const { view, threadId, href, selected, setSelected, listRef, listHidden, helpdesk } = options;
  const threads: (ThreadSummary | ConversationSummary)[] = helpdesk
    ? helpdesk.conversations
    : options.threads;
  const navigate = useNavigate();
  const location = useLocation();
  const markRead = useMarkRead();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  const moveToLater = useMoveToLater();
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
    if (selected === "all") return [...threads];
    if (selected.size) return threads.filter((t) => selected.has(t.id));
    const id = cursor();
    return threads.filter((t) => t.id === id);
  };

  /**
   * Runs an action on the targets. Threads it takes out of this view (`leaves`) move the cursor
   * to the nearest row that stays, and the open thread to that row (or closed).
   */
  const act = <T extends ThreadSummary | ConversationSummary>(
    list: T[],
    run: (list: T[]) => void,
    leaves: (t: T) => boolean,
    said: (n: number) => string,
    inverse?: (list: T[]) => void,
  ) => {
    if (!list.length) return;
    const gone = new Set(list.filter(leaves).map((t) => t.id));
    const at = ids.indexOf(cursor() ?? "");
    const stays = (id: string | undefined) => !!id && !gone.has(id);
    const neighbour =
      ids.slice(at + 1).find(stays) ?? ids.slice(0, Math.max(at, 0)).findLast(stays);
    const hadFocus = !!listRef.current?.contains(document.activeElement);
    run(list);
    setSelected(new Set());
    announce(said(list.length));
    if (inverse) offerUndo(said(list.length), () => inverse(list));
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
   * selection can mix done, Later and plain threads). Done clears Later and Later clears done on
   * the server, so the earlier state is set again rather than the action reversed.
   */
  const restore = (applied: "done" | "undone" | "later" | "unlater") => (t: ThreadSummary) => {
    if (t.done) {
      if (applied !== "done") markDone.mutate({ threadId: t.id, through: t.lastMessageAt });
    } else if (t.later) {
      moveToLater.mutate({ threadId: t.id, later: true });
    } else if (applied === "done") {
      markUndone.mutate({ threadId: t.id });
    } else if (applied === "later") {
      moveToLater.mutate({ threadId: t.id, later: false });
    }
  };

  /** Plain thread rows under the cursor or selected (none on a helpdesk list). */
  const threadTargets = () => (helpdesk ? [] : (targets() as ThreadSummary[]));

  const bulk = useBulkChange();
  /**
   * One conversation change on every target in one bulk request, with one undo for the batch that
   * puts every row back as it was. A row leaves the list when its new state no longer fits the
   * view (unknown: stays).
   */
  const change = (made: ConversationChange, said: (n: number) => string) => {
    if (!helpdesk) return;
    const { filter } = helpdesk;
    const me = bulk.me(filter.mailbox);
    act(
      targets() as ConversationSummary[],
      (list) =>
        bulk.run(
          list.map((t) => t.id),
          made,
          { mailboxId: filter.mailbox, undo: said(list.length) },
        ),
      (t) => inView(applyChange(t, made), filter, me) === false,
      said,
    );
  };

  const has = threads.length > 0;
  const plain = has && !helpdesk;
  const conversations = has && !!helpdesk;
  const conversationsLabel = (n: number) => (n === 1 ? "Conversation" : `${n} conversations`);
  useShortcut(
    "resolve",
    () => {
      const back = (targets() as ConversationSummary[]).every((t) => t.status === "resolved");
      change(
        back ? { type: "reopen" } : { type: "resolve" },
        (n) => `${conversationsLabel(n)} ${back ? "reopened" : "resolved"}`,
      );
    },
    conversations,
  );
  useShortcut(
    "snooze",
    () => {
      const back = (targets() as ConversationSummary[]).every((t) => t.status === "snoozed");
      const until = new Date(Date.now() + SNOOZE_MS).toISOString();
      change(
        back ? { type: "reopen" } : { type: "snooze", until },
        (n) => `${conversationsLabel(n)} ${back ? "reopened" : "snoozed until tomorrow"}`,
      );
    },
    conversations,
  );
  useShortcut(
    "assignToMe",
    () => {
      const me = helpdesk && bulk.me(helpdesk.filter.mailbox);
      change({ type: "claim", memberId: me }, (n) => `${conversationsLabel(n)} assigned to you`);
    },
    conversations,
  );
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
      const list = threadTargets();
      const undo = list.every((t) => t.done);
      act(
        list,
        each((t) =>
          undo
            ? markUndone.mutate({ threadId: t.id })
            : markDone.mutate({ threadId: t.id, through: t.lastMessageAt }),
        ),
        () => leavesView(undo ? "undone" : "done", view),
        (n) => `${plural(n)} ${undo ? "back in the Inbox" : "marked done"}`,
        each(restore(undo ? "undone" : "done")),
      );
    },
    plain,
  );
  useShortcut(
    "later",
    () => {
      const list = threadTargets();
      const back = list.every((t) => t.later);
      act(
        list,
        each((t) => moveToLater.mutate({ threadId: t.id, later: !back })),
        () => leavesView(back ? "unlater" : "later", view),
        (n) => `${plural(n)} ${back ? "back in the Inbox" : "moved to Later"}`,
        each(restore(back ? "unlater" : "later")),
      );
    },
    plain,
  );
  useShortcut(
    "read",
    () => {
      const list = targets();
      const read = list.some((t) => t.unread);
      act(
        list,
        each((t: ThreadSummary | ConversationSummary) => markRead.mutate({ threadId: t.id, read })),
        () => false,
        (n) => `${plural(n)} marked ${read ? "read" : "unread"}`,
      );
    },
    has,
  );
  useShortcut("close", close, !!threadId);
}
