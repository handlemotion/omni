import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import {
  IconCheck,
  IconClock3,
  IconInbox,
  IconMail,
  IconMailOpen,
  IconMaximize,
  IconMinimize,
  IconX,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { IconBubble } from "@/components/icons/sidebar";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { ShowMore } from "@/components/ui/show-more";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useLeaveOpenThread, useOpenList } from "@/components/inbox/open-list";
import { useConversation } from "@/hooks/use-conversation.ts";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useAllMailboxes, useThread } from "@/hooks/use-mail.ts";
import { useFollowMerge } from "@/hooks/use-realtime.ts";
import {
  useMarkDone,
  useMarkRead,
  useMarkReadOnOpen,
  useMarkUndone,
  useMoveToLater,
} from "@/hooks/use-mail-actions.ts";
import type { Conversation as HelpdeskState, Message, Thread } from "@/lib/types.ts";
import { ReplyComposer } from "../compose/composer.tsx";
import { ComposerProvider, useComposerState } from "../compose/composer-state.tsx";
import { FloatingReply } from "../compose/floating-actions.tsx";
import { SelectionReply } from "../compose/selection-reply.tsx";
import { EventLine, NoteItem, useEventLines } from "./activity.tsx";
import { AddedLine, MessageItem, PendingItem, scrollToMessage } from "./message.tsx";
import { Properties } from "./properties.tsx";
import { ThreadSwitcher } from "./thread-switcher.tsx";

/** Past this many messages, the middle of a thread folds behind one button. */
const FOLD_OVER = 12;
/** What stays open around the fold: the opening message and the latest ones. */
const KEEP_FIRST = 1;
const KEEP_LAST = 8;

/**
 * The open conversation beside the list: its actions and subject, then the messages
 * oldest first, ending at the newest with the reply box under it.
 */
export function Conversation({ threadId }: { threadId: string }) {
  const { thread, pending, error } = useThread(threadId);
  useMarkReadOnOpen(thread);
  const shared = useAllMailboxes().data?.find((m) => m.id === thread?.mailboxId)?.kind === "shared";
  // Notes and activity: shared inboxes only (a personal thread has no helpdesk state).
  const { data: helpdesk } = useConversation(threadId, { enabled: shared });
  // Merged into another conversation: show that one, from the same list.
  const navigate = useNavigate();
  useFollowMerge(
    threadId,
    (into) =>
      void navigate({
        to: ".",
        params: (params: Record<string, string>) => ({ ...params, threadId: into }),
        search: (search: Record<string, unknown>) => search,
        replace: true,
      } as never),
  );
  const [fullScreen] = useFullScreen();
  const scroller = useRef<HTMLDivElement>(null);
  // A shared email the team started talking about reads as a conversation, as a reply makes it.
  const [started, setStarted] = useState<string>();
  const single =
    isSingleEmail(thread, pending.length, shared ? helpdesk : undefined) && started !== threadId;
  // Whether the reader sat at the bottom before this render: new mail follows them only then.
  const atBottom = useRef(true);

  // To the very end, so the newest message sits just above the docked composer. A single
  // email is a page, read from its top.
  const toEnd = () =>
    scroller.current?.scrollTo({ top: single ? 0 : scroller.current.scrollHeight });
  // A conversation opens at its newest message, like a chat.
  useLayoutEffect(() => {
    atBottom.current = true;
    toEnd();
  }, [threadId]);
  // A new message or reply keeps the newest in view, unless they scrolled up to read.
  useLayoutEffect(() => {
    if (atBottom.current) toEnd();
  }, [thread?.messages.length, pending.length, helpdesk?.notes.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // The screen opens before the thread arrives (the route doesn't wait): a skeleton of it until
  // then, which skullet holds back 150 ms, so a thread warmed by hovering its row never shows one.
  // A thread that failed to load (gone, no access, retries spent) goes to the route's error
  // screen, as it did when the loader waited for it, rather than a skeleton that never ends.
  if (error && !thread) throw error;
  if (!thread) return <ConversationSkeleton />;
  const subject = thread.messages.at(-1)?.subject || thread.messages[0]?.subject || "";

  return (
    <section aria-label="Conversation" className={SECTION}>
      <Actions thread={thread} subject={subject} />
      {/* The divider from the list runs beside the messages only; the toolbar row stays open,
          continuing the list's header row. */}
      {/* Per conversation: the timeline's menus and selections steer the composer under it. */}
      <ComposerProvider
        key={threadId}
        chat={shared}
        chatOpen={!single}
        onStartChat={() => setStarted(threadId)}
      >
        {/* A shared conversation's status, owner, priority and tags, under the title. */}
        {shared && <PropertiesRow thread={thread} />}
        <SelectionReply threadId={threadId} />
        <div
          ref={scroller}
          onScroll={onScroll}
          // Full screen, the sidebar's own edge is the only line: a second beside it doubles up.
          className={`${SCROLLER} overflow-y-auto overscroll-none ${fullScreen ? "" : "border-s"}`}
        >
          {/* Grows to fill a short thread, so the composer stays at the pane's bottom. */}
          {/* A shared inbox leaves room at the end for the properties pill over the composer. */}
          <div className={columnClass(single)}>
            <Timeline
              key={threadId}
              threadId={threadId}
              mailboxId={thread.mailboxId}
              mailboxAddress={thread.mailboxAddress}
              messages={thread.messages}
              helpdesk={shared ? helpdesk : undefined}
              flat={single}
            />
            {pending.map((send) => (
              <PendingItem key={send.key} send={send} />
            ))}
          </div>
          {/* The pane's bottom edge, full width; the messages scroll above it. */}
          <div className="sticky bottom-0 w-full shrink-0 bg-background">
            {/* Reply and Forward float here until a composer docks in their place. */}
            <FloatingReply thread={thread} />
            <ReplyComposer thread={thread} />
          </div>
        </div>
      </ComposerProvider>
    </section>
  );
}

/**
 * A shared conversation's status, owner, priority and tags, in a row of its own under the top
 * bar; on a single email, ending with Start conversation, which opens the team's hidden notes.
 */
function PropertiesRow({ thread }: { thread: Thread }) {
  const composer = useComposerState();
  return (
    // 52px, as tall as a list row.
    <div className="flex h-13 shrink-0 items-center border-s border-b px-3">
      <Properties thread={thread}>
        {!composer.open && (
          <Button intent="ghost" size="sm" onPress={composer.startChat}>
            <IconBubble />
            Start conversation
          </Button>
        )}
      </Properties>
    </div>
  );
}

/**
 * A single email reads as the page: full width, no card, read from its top. A reply or a
 * note makes it a conversation again.
 */
function isSingleEmail(
  thread: Thread | undefined,
  pending: number,
  helpdesk: HelpdeskState | undefined,
) {
  return thread?.messages.length === 1 && !pending && !helpdesk?.notes.length;
}

// The reader's layout, shared by the conversation and its skeleton so the two line up.
const SECTION = "flex min-w-0 flex-1 flex-col";
const SCROLLER = "flex min-h-0 flex-1 flex-col";
// 40px under the last message: more than the 24px between messages, so the newest one doesn't
// sit on the composer when scrolled to the end.
const COLUMN = "mx-auto flex w-full max-w-3xl grow flex-col gap-6 px-5 pt-6 pb-10";
// A single email: the column without its width cap.
const PAGE = "flex w-full grow flex-col gap-6 px-5 pt-5 pb-6";

/** The messages' column, with room at the end for what floats over the composer. */
function columnClass(single: boolean) {
  // Room at the end for the floating Reply and Forward (and a shared inbox's properties pill).
  return `${single ? PAGE : COLUMN} pb-20`;
}

/**
 * The thread while it loads: the toolbar, a subject and a few messages, drawn from skullet's
 * boxes in the reader's own layout. Not measured from sample messages, which cost every open.
 */
function ConversationSkeleton() {
  return (
    <section aria-label="Conversation" className={SECTION}>
      <Skeleton
        loading
        label="Loading conversation"
        className={SECTION}
        skeleton={
          <>
            {/* The top bar: the subject, then 28px buttons with 16px icons, as `Actions` lays them
                out. */}
            <div className="flex h-12 shrink-0 items-center gap-3 border-s border-b ps-5 pe-4">
              <span className="min-w-0 flex-1">
                <SkeletonBox width="45%" height={14} />
              </span>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonBox key={i} width={16} height={16} radius={4} />
              ))}
            </div>
            <div className={`${SCROLLER} overflow-hidden border-s`}>
              <div className={COLUMN}>
                <MessageBones width="55%" />
                <MessageBones width="25%" ours />
                <MessageBones width="40%" />
              </div>
            </div>
          </>
        }
      >
        {null}
      </Skeleton>
    </section>
  );
}

/** A message as a bubble: the sender's line over it, on the left (or yours, on the right). */
function MessageBones({ width, ours = false }: { width: string; ours?: boolean }) {
  return (
    <div className={`flex flex-col gap-3 ${ours ? "items-end" : "items-start"}`}>
      <div className="flex items-center gap-2">
        {!ours && <SkeletonBox width={18} height={18} radius={4} />}
        <SkeletonBox width={56} height={10} />
        <SkeletonBox width={72} height={10} />
      </div>
      <SkeletonBox width={width} height={36} radius={12} />
    </div>
  );
}

/**
 * The messages, and on a shared inbox its notes and activity between them, oldest first. A long
 * thread folds its middle until asked, so a hundred-message thread mounts ten; each entry also
 * skips layout and paint while off screen (`content-visibility`).
 */
function Timeline(props: {
  threadId: string;
  mailboxId: string;
  /** The inbox's own address: it reads as "You" among a message's recipients. */
  mailboxAddress: string;
  messages: Message[];
  helpdesk: HelpdeskState | undefined;
  flat?: boolean;
}) {
  const { threadId, mailboxId, mailboxAddress, messages, helpdesk, flat } = props;
  const [unfolded, setUnfolded] = useState(false);
  // A message folded away mounts once the fold opens, then scrolls into view.
  const show = (id: string) => {
    if (scrollToMessage(id)) return;
    setUnfolded(true);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToMessage(id)));
  };
  const lines = useEventLines(mailboxId, helpdesk?.events ?? []);
  // Each message by its Message-ID, for the one a team reply answered.
  const byHeader = new Map(messages.map((m) => [m.messageIdHeader, m]));
  const entries: { at: string; key: string; node: ReactNode }[] = [
    ...messages.map((message) => ({
      at: message.sentAt,
      key: message.id,
      node: (
        <>
          <AddedLine message={message} />
          <MessageItem
            threadId={threadId}
            message={message}
            self={mailboxAddress}
            flat={flat}
            repliedTo={message.inReplyTo ? byHeader.get(message.inReplyTo) : undefined}
            onShow={show}
          />
        </>
      ),
    })),
    ...(helpdesk?.notes ?? []).map((note) => ({
      at: note.createdAt,
      key: note.id,
      node: <NoteItem threadId={threadId} mailboxId={mailboxId} note={note} />,
    })),
    ...lines.map(({ event, text }) => ({
      at: event.createdAt,
      key: event.id,
      node: <EventLine event={event} text={text} />,
    })),
  ];
  // Stable: a message and the event it caused keep their order (the message first).
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const fold = !unfolded && entries.length > FOLD_OVER;
  const head = fold ? entries.slice(0, KEEP_FIRST) : entries;
  const tail = fold ? entries.slice(-KEEP_LAST) : [];
  const hidden = entries.length - head.length - tail.length;

  const render = (entry: (typeof entries)[number]) => <Entry key={entry.key}>{entry.node}</Entry>;
  return (
    <>
      {head.map(render)}
      {fold && (
        <ShowMore isSelected={false} onChange={() => setUnfolded(true)}>
          {hidden} earlier
        </ShowMore>
      )}
      {tail.map(render)}
    </>
  );
}

function Entry({ children }: { children: ReactNode }) {
  // Off-screen messages keep a guessed height instead of laying out; `auto` remembers the real
  // one once seen, so scrolling back does not jump. `content-visibility` clips paint to the box,
  // so 6px of padding on every side (taken back by the margin) leaves room for the header's
  // buttons and their 5px focus ring, which reach past the article's edges.
  return (
    <div className="-m-1.5 flex flex-col gap-3 p-1.5 [contain-intrinsic-size:auto_160px] [content-visibility:auto]">
      {children}
    </div>
  );
}

/**
 * The actions at the right of the bar over the conversation, the same on every thread (ADR 0032):
 * done and later (yours alone), read state and full screen. A shared conversation's team state
 * (status, owner, priority, tags) is the rail under its title.
 */
function Actions({ thread, subject }: { thread: Thread; subject: string }) {
  const markRead = useMarkRead();
  const [fullScreen, toggleFullScreen] = useFullScreen();
  const navigate = useNavigate();
  const closeHref = useOpenList()?.closeHref;

  return (
    // The reading column's top bar: the subject, then the actions. One row with the list's
    // header beside it, the same height and bottom line; end-2.5 matches that header's inset.
    <div
      className={`flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2.5 ${fullScreen ? "" : "border-s"}`}
    >
      {/* Full screen hides the list: switch threads from here, before the subject. */}
      {fullScreen && (
        <div className="-ms-2 flex max-w-[40%] shrink-0 items-center">
          <ThreadSwitcher threadId={thread.id} />
        </div>
      )}
      {/* 1px down, like the list's title beside it: the capitals centre on the icons. */}
      {/* 14px, cut in its middle: a long subject keeps its start and its end. */}
      <Heading
        level={2}
        className="min-w-0 flex-1 translate-y-px text-md"
        title={subject || undefined}
      >
        <MiddleTruncate text={subject || "(no subject)"} />
      </Heading>
      <div className="flex shrink-0 items-center gap-1">
        <TriageActions thread={thread} />
        <Action
          label={thread.read ? "Mark unread" : "Mark read"}
          onPress={() => markRead.mutate({ threadId: thread.id, read: !thread.read })}
        >
          {thread.read ? <IconMail /> : <IconMailOpen />}
        </Action>
        <Action label={fullScreen ? "Side by side" : "Full screen"} onPress={toggleFullScreen}>
          {fullScreen ? <IconMinimize /> : <IconMaximize />}
        </Action>
        {/* Back to the list alone, as Esc and a click on the open row do. */}
        {closeHref && (
          <Action label="Close" onPress={() => void navigate({ href: closeHref })}>
            <IconX />
          </Action>
        )}
      </div>
    </div>
  );
}

/**
 * Done and Later, which act for you alone, on a personal thread and on a shared conversation
 * alike (ADR 0032): a teammate's Done, reply, assignment or status never clears it for you.
 */
function TriageActions({ thread }: { thread: Thread }) {
  const threadId = thread.id;
  const moveToLater = useMoveToLater();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  // Taken out of the list behind it, the thread gives way to the next row, as `e` and `h` do.
  const leave = useLeaveOpenThread();
  return (
    <>
      <Action
        label={thread.done ? "Not done" : "Done"}
        onPress={() => {
          leave(threadId, thread.done ? "undone" : "done");
          if (thread.done) markUndone.mutate({ threadId });
          else markDone.mutate({ threadId, through: thread.lastMessageAt });
        }}
      >
        {thread.done ? <IconInbox /> : <IconCheck />}
      </Action>
      <Action
        label={thread.later ? "Back to inbox" : "Later"}
        onPress={() => {
          leave(threadId, thread.later ? "unlater" : "later");
          moveToLater.mutate({ threadId, later: !thread.later });
        }}
      >
        {thread.later ? <IconInbox /> : <IconClock3 />}
      </Action>
    </>
  );
}

function Action(props: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      <Button intent="ghost" size="sq-sm-lg" aria-label={props.label} onPress={props.onPress}>
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}
