import { useNavigate } from "@tanstack/react-router";
import type { ReactNode, RefObject } from "react";
import { requestCompose } from "@/components/compose/composer-state";
import {
  IconCheck,
  IconClock3,
  IconForward,
  IconInbox,
  IconMail,
  IconMailOpen,
  IconReply,
  IconTrash,
} from "@/components/icons/central";
import { contextMenuProps, type ContextMenuEntry } from "@/components/ui/context-menu";
import {
  useMarkDone,
  useMarkRead,
  useMarkUndone,
  useMoveToLater,
  useMoveToTrash,
} from "@/hooks/use-mail-actions.ts";
import type { ThreadListActions } from "@/hooks/use-thread-list-shortcuts.ts";
import type { ListRow } from "./thread-list.tsx";

/**
 * The list's rows with their context menu: a right-click (or a long press, or Shift+F10 on the
 * focused row) opens the row's actions at the pointer, on the whole selection when the row is in
 * it. One menu for the whole list, since only the rows on screen exist. Off a row, the areas
 * around the list (and the app's fallback) answer.
 */
export function RowMenu(props: {
  rows: ListRow[];
  href: (threadId: string) => string;
  /** The list's own actions (the keys'), which know its selection and cursor; unset on a list without them. */
  actions: RefObject<ThreadListActions | null>;
  /** Mail already in Trash has nowhere further to go. */
  inTrash?: boolean;
  children: ReactNode;
}) {
  const run = useRowActions(props.href, props.actions);
  const entries = (row: ListRow) =>
    [
      { icon: IconReply, label: "Reply", onAction: () => run.compose(row.id, "reply") },
      { icon: IconForward, label: "Forward", onAction: () => run.compose(row.id, "forward") },
      "separator",
      row.triage && {
        icon: row.triage.done ? IconInbox : IconCheck,
        label: row.triage.done ? "Not done" : "Done",
        onAction: () => run.done(row),
      },
      row.triage && {
        icon: row.triage.later ? IconInbox : IconClock3,
        label: row.triage.later ? "Back to inbox" : "Later",
        onAction: () => run.later(row),
      },
      {
        icon: row.unread ? IconMailOpen : IconMail,
        label: row.unread ? "Mark read" : "Mark unread",
        onAction: () => run.read(row),
      },
      !props.inTrash && "separator",
      !props.inTrash && { icon: IconTrash, label: "Move to trash", onAction: () => run.trash(row) },
    ] satisfies ContextMenuEntry[];
  const menu = contextMenuProps((target) => {
    const key = target.closest("[data-key]")?.getAttribute("data-key");
    const row = key ? props.rows.find((r) => r.id === key) : undefined;
    return row ? entries(row) : null;
  }, "Thread actions");

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...menu}>
      {props.children}
    </div>
  );
}

function useRowActions(
  href: (threadId: string) => string,
  actions: RefObject<ThreadListActions | null>,
) {
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  const moveToLater = useMoveToLater();
  const moveToTrash = useMoveToTrash();
  return {
    compose: (id: string, kind: "reply" | "forward") => {
      requestCompose({ threadId: id, kind });
      void navigate({ href: href(id) });
    },
    done: ({ id, triage }: ListRow) => {
      if (actions.current) return actions.current.done(id);
      if (triage?.done) markUndone.mutate({ threadId: id });
      else if (triage) markDone.mutate({ threadId: id, through: triage.lastMessageAt });
    },
    later: ({ id, triage }: ListRow) => {
      if (actions.current) return actions.current.later(id);
      moveToLater.mutate({ threadId: id, later: !triage?.later });
    },
    read: ({ id, unread }: ListRow) => {
      if (actions.current) return actions.current.read(id);
      markRead.mutate({ threadId: id, read: unread });
    },
    trash: ({ id }: ListRow) => {
      if (actions.current) return actions.current.trash(id);
      moveToTrash.mutate({ threadId: id });
    },
  };
}
