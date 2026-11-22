import { EmptyState } from "@/components/empty/empty-state";
import { useLayoutEffect, useRef, useState, type Key, type ReactNode } from "react";
import { Skeleton } from "skullet/react";
import {
  IconCheck,
  IconPencil,
  IconReply,
  IconRestore,
  IconTrash,
  IconX,
} from "@/components/icons/central";
import { ChatBox } from "@/components/chat/chat-box";
import { ChatEdit, ChatMenu, ChatText, menuButtonClass } from "@/components/chat/chat-message";
import { messageTime } from "@/components/conversation/message.tsx";
import { CountBadge } from "@/components/shell/count-badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { MenuItem, MenuLabel } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tab, TabList, Tabs } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useAddComment,
  useChangeComment,
  useDeleteComment,
  useStorageComments,
} from "@/hooks/use-storage.ts";
import type { DocComments } from "@/hooks/use-doc-comments.ts";
import { useSession } from "@/hooks/use-session.ts";
import type { StorageNode } from "@/lib/storage.ts";
import {
  commentAuthor,
  threadsOf,
  type StorageComment,
  type StorageComments,
  type StorageThread,
} from "@/lib/storage-comments.ts";
import { CommentComposer } from "./preview/comment-composer.tsx";
import { storageErrorToast } from "./storage-errors.ts";

const SAMPLE: StorageComments = {
  contentVersion: 1,
  comments: [
    {
      id: "sample",
      parentId: null,
      contentVersion: 1,
      anchor: { kind: "file" },
      body: "A comment on this file",
      authorName: "Someone",
      mine: false,
      createdAt: new Date(0).toISOString(),
      editedAt: null,
      resolvedAt: null,
      resolvedByName: null,
    },
  ],
};

interface Door {
  id: string;
  shareId?: string | undefined;
}

const withShare = ({ id, shareId }: Door) => ({ id, ...(shareId ? { shareId } : {}) });

type View = "open" | "resolved";

function useStickToBottom(count: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { scroller, onScroll };
}

export function CommentsPanel(props: {
  node: StorageNode;
  shareId?: string | undefined;
  onClose: () => void;
  /** Beside a doc: threads show the passage they are on, and pick it out in the doc. */
  doc?: DocComments | undefined;
}) {
  const { node, shareId, doc } = props;
  const door = { id: node.id, shareId };
  const comments = useStorageComments(node.id, shareId);
  const [view, setView] = useState<View>("open");
  const [replying, setReplying] = useState<string | null>(null);
  const all = comments.data?.comments ?? [];
  const open = threadsOf(all, false).length;
  const { scroller, onScroll } = useStickToBottom(all.length);
  return (
    <section
      aria-label={`Comments on ${node.name}`}
      className="flex min-w-0 flex-1 flex-col border-s bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 ps-5 pe-2.5">
        <Heading level={2} className="shrink-0 text-md">
          Comments
        </Heading>
        <span className="min-w-0 flex-1 text-sm text-muted-foreground" title={node.name}>
          <MiddleTruncate text={node.name} />
        </span>
        <TooltipTrigger delay={400}>
          <Button intent="outline" size="sq-sm" aria-label="Close" onPress={props.onClose}>
            <IconX />
          </Button>
          <Tooltip>Close</Tooltip>
        </TooltipTrigger>
      </div>
      <Tabs
        selectedKey={view}
        onSelectionChange={(key: Key) => setView(key as View)}
        className="w-full shrink-0 gap-0"
      >
        <TabList
          aria-label="Show"
          className="-mt-0.5 px-5 [--tab-list-pb:--spacing(2)] [--tab-list-tab-y:--spacing(0.5)]"
        >
          <Tab id="open" className="gap-1.5">
            Open
            <CountBadge count={open} />
          </Tab>
          <Tab id="resolved">Resolved</Tab>
        </TabList>
      </Tabs>
      {doc?.pending && (
        <div className="flex shrink-0 flex-col gap-2.5 border-b px-5 pt-3 pb-4">
          <Quote text={doc.pending.quote} active />
          <CommentComposer
            key={JSON.stringify(doc.pending)}
            fileId={node.id}
            shareId={shareId}
            anchor={doc.pending}
            onClose={doc.cancel}
            onSent={doc.cancel}
          />
        </div>
      )}
      {comments.data && threadsOf(comments.data.comments, view === "resolved").length === 0 ? (
        <EmptyState
          figure="dish"
          title={view === "resolved" ? "No resolved comments" : "No comments"}
          className="min-h-0 p-5 pb-24"
        />
      ) : (
        <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <Skeleton
            id="storage-comments"
            data={comments.data}
            sample={SAMPLE}
            label="Loading comments"
          >
            {(state) => (
              <ul>
                {threadsOf(state.comments, view === "resolved").map((thread) => (
                  <CommentRow
                    key={thread.root.id}
                    door={door}
                    thread={thread}
                    replying={replying === thread.root.id}
                    onReplying={(on) => setReplying(on ? thread.root.id : null)}
                    doc={doc}
                  />
                ))}
              </ul>
            )}
          </Skeleton>
        </div>
      )}
    </section>
  );
}

const AVATAR =
  "shrink-0 bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-md)] [--avatar-size:--spacing(6)]";

function Quote(props: { text: string; active: boolean; onPress?: () => void }) {
  const edge = `border-s-2 ps-2.5 text-sm text-muted-foreground ${props.active ? "border-warning" : "border-border"}`;
  if (!props.onPress) return <p className={`line-clamp-2 ${edge}`}>{props.text}</p>;
  return (
    <Button
      intent="plain"
      size="text"
      className={`w-full justify-start rounded-none text-start ${edge}`}
      onPress={props.onPress}
    >
      <span className="line-clamp-2">{props.text}</span>
    </Button>
  );
}

function CommentRow(props: {
  door: Door;
  thread: StorageThread;
  replying: boolean;
  onReplying: (on: boolean) => void;
  doc?: DocComments | undefined;
}) {
  const { door, thread, doc } = props;
  const { root } = thread;
  const quote = doc && root.anchor?.kind === "text" ? root.anchor.quote : null;
  const active = !!doc && doc.active === root.id;
  const row = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const messages = [root, ...thread.replies];
  const me = useSession().data?.user.name ?? "";
  const change = useChangeComment();
  const resolve = (resolved: boolean) =>
    change.mutate(
      { ...withShare(door), commentId: root.id, change: { resolved } },
      { onError: (error) => storageErrorToast(error, "It was not changed") },
    );
  const resolved = !!root.resolvedAt;
  const onReply = () => props.onReplying(true);
  return (
    <li
      ref={row}
      className={`border-b px-5 py-4 ${active ? "bg-secondary/60" : ""}`}
      aria-label={`Comment from ${commentAuthor(root)}`}
      aria-current={active || undefined}
    >
      {quote !== null && (
        <div className="mb-3 flex">
          <Quote text={quote} active={active} onPress={() => doc?.pick(root.id)} />
        </div>
      )}
      <ol>
        {messages.map((comment, index) => (
          <Message
            key={comment.id}
            door={door}
            comment={comment}
            joined={index < messages.length - 1 || props.replying}
            {...(index === 0 && {
              actions: (
                <TooltipTrigger delay={400}>
                  <Button
                    intent="ghost"
                    size="sq-2xs"
                    aria-label={resolved ? "Reopen" : "Resolve"}
                    className={menuButtonClass({})}
                    onPress={() => resolve(!resolved)}
                  >
                    {resolved ? <IconRestore /> : <IconCheck />}
                  </Button>
                  <Tooltip>{resolved ? "Reopen" : "Resolve"}</Tooltip>
                </TooltipTrigger>
              ),
            })}
            onReply={onReply}
          />
        ))}
        {props.replying && (
          <li className="flex gap-3">
            <span className="pt-1">
              <Avatar isSquare initials={me.slice(0, 1).toUpperCase()} className={AVATAR} />
            </span>
            <div className="min-w-0 flex-1">
              <ReplyBox door={door} parentId={root.id} onCancel={() => props.onReplying(false)} />
            </div>
          </li>
        )}
      </ol>
    </li>
  );
}

function Message(props: {
  door: Door;
  comment: StorageComment;
  joined: boolean;
  actions?: ReactNode;
  onReply: () => void;
}) {
  const { door, comment } = props;
  const [editing, setEditing] = useState(false);
  const change = useChangeComment();
  const remove = useDeleteComment();
  const name = commentAuthor(comment);
  const target = { ...withShare(door), commentId: comment.id };
  return (
    <li className="group/item flex gap-3">
      <span className="flex shrink-0 flex-col items-center">
        <Avatar isSquare initials={name.slice(0, 1).toUpperCase()} className={AVATAR} />
        {props.joined && <span aria-hidden className="my-1.5 w-px flex-1 bg-border" />}
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 ${props.joined ? "pb-5" : ""}`}>
        <span className="flex h-6 min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
          <time
            dateTime={comment.createdAt}
            className="shrink-0 text-xs text-subtle-foreground tabular-nums"
          >
            {messageTime(comment.createdAt)}
            {comment.editedAt && " · edited"}
          </time>
          <span className="ms-auto flex shrink-0 items-center gap-0.5">
            {props.actions}
            {!editing && (
              <ChatMenu label="Comment actions">
                <MenuItem textValue="Reply" onAction={props.onReply}>
                  <IconReply data-slot="icon" />
                  <MenuLabel>Reply</MenuLabel>
                </MenuItem>
                {comment.mine && (
                  <>
                    <MenuItem textValue="Edit" onAction={() => setEditing(true)}>
                      <IconPencil data-slot="icon" />
                      <MenuLabel>Edit</MenuLabel>
                    </MenuItem>
                    <MenuItem
                      intent="danger"
                      textValue="Delete"
                      onAction={() =>
                        remove.mutate(target, {
                          onError: (error) => storageErrorToast(error, "It was not deleted"),
                        })
                      }
                    >
                      <IconTrash data-slot="icon" />
                      <MenuLabel>Delete</MenuLabel>
                    </MenuItem>
                  </>
                )}
              </ChatMenu>
            )}
          </span>
        </span>
        {editing ? (
          <ChatEdit
            label="Edit comment"
            text={comment.body}
            onDone={() => setEditing(false)}
            onSave={(body) =>
              change.mutate(
                { ...target, change: { body } },
                { onError: (error) => storageErrorToast(error, "It was not saved") },
              )
            }
          />
        ) : (
          <ChatText>{comment.body}</ChatText>
        )}
      </div>
    </li>
  );
}

function ReplyBox(props: { door: Door; parentId: string; onCancel: () => void }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const add = useAddComment();
  const sending = useRef(false);
  useLayoutEffect(() => {
    textarea.current?.focus();
  }, []);
  const send = () => {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true;
    add.mutate(
      { ...withShare(props.door), body: { body, parentId: props.parentId } },
      {
        onSuccess: () => setText((current) => (current.trim() === body ? "" : current)),
        onError: (error) => storageErrorToast(error, "It was not sent"),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };
  return (
    <ChatBox
      compact
      textareaRef={textarea}
      label="Reply"
      placeholder="Reply"
      sendLabel="Send reply"
      canSend={text.trim().length > 0 && !add.isPending}
      onSend={send}
      value={text}
      onChange={(next) => setText(next)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    />
  );
}
