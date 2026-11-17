import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
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
import { ContextMenuTrigger, Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
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
 * focused row) opens the row's actions at the pointer. One menu for the whole list, since only
 * the rows on screen exist. Off a row, the browser's own menu shows.
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
  const [target, setTarget] = useState<string>();
  const row = props.rows.find((r) => r.id === target);
  const run = useRowActions(props.href, props.actions);

  const pick = (event: SyntheticEvent, from: Element | null) => {
    const key = from?.closest("[data-key]")?.getAttribute("data-key");
    if (key && props.rows.some((r) => r.id === key)) setTarget(key);
    else event.stopPropagation();
  };

  return (
    <ContextMenuTrigger>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onContextMenuCapture={(event) => pick(event, event.target as Element)}
        onKeyDownCapture={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            pick(event, document.activeElement);
          }
        }}
      >
        {props.children}
      </div>
      <Menu aria-label="Thread actions" popover={{ offset: 2 }}>
        {row && (
          <>
            <MenuItem textValue="Reply" onAction={() => run.compose(row.id, "reply")}>
              <IconReply data-slot="icon" />
              <MenuLabel>Reply</MenuLabel>
            </MenuItem>
            <MenuItem textValue="Forward" onAction={() => run.compose(row.id, "forward")}>
              <IconForward data-slot="icon" />
              <MenuLabel>Forward</MenuLabel>
            </MenuItem>
            <MenuSeparator />
            {row.triage && (
              <MenuItem
                textValue={row.triage.done ? "Not done" : "Done"}
                onAction={() => run.done(row)}
              >
                {row.triage.done ? <IconInbox data-slot="icon" /> : <IconCheck data-slot="icon" />}
                <MenuLabel>{row.triage.done ? "Not done" : "Done"}</MenuLabel>
              </MenuItem>
            )}
            {row.triage && (
              <MenuItem
                textValue={row.triage.later ? "Back to inbox" : "Later"}
                onAction={() => run.later(row)}
              >
                {row.triage.later ? (
                  <IconInbox data-slot="icon" />
                ) : (
                  <IconClock3 data-slot="icon" />
                )}
                <MenuLabel>{row.triage.later ? "Back to inbox" : "Later"}</MenuLabel>
              </MenuItem>
            )}
            <MenuItem
              textValue={row.unread ? "Mark read" : "Mark unread"}
              onAction={() => run.read(row)}
            >
              {row.unread ? <IconMailOpen data-slot="icon" /> : <IconMail data-slot="icon" />}
              <MenuLabel>{row.unread ? "Mark read" : "Mark unread"}</MenuLabel>
            </MenuItem>
            {!props.inTrash && (
              <>
                <MenuSeparator />
                <MenuItem textValue="Move to trash" onAction={() => run.trash(row)}>
                  <IconTrash data-slot="icon" />
                  <MenuLabel>Move to trash</MenuLabel>
                </MenuItem>
              </>
            )}
          </>
        )}
      </Menu>
    </ContextMenuTrigger>
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
