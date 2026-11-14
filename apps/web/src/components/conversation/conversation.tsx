import { useLocation, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import {
  IconArchive,
  IconCheck,
  IconCircle,
  IconCircleCheck,
  IconClock3,
  IconClockSnooze,
  IconInbox,
  IconMail,
  IconMailOpen,
  IconMaximize,
  IconMinimize,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { ShowMore } from "@/components/ui/show-more";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useConversation, useReopen, useResolve, useSnooze } from "@/hooks/use-conversation.ts";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useAllMailboxes, useThread } from "@/hooks/use-mail.ts";
import { useFollowMerge } from "@/hooks/use-realtime.ts";
import {
  useArchive,
  useMarkDone,
  useMarkRead,
  useMarkReadOnOpen,
  useMarkUndone,
  useMoveToLater,
} from "@/hooks/use-mail-actions.ts";
import type { Conversation as HelpdeskState, Message, Thread } from "@/lib/types.ts";
import { ReplyComposer } from "../compose/composer.tsx";
import { ComposerProvider } from "../compose/composer-state.tsx";
import { SelectionReply } from "../compose/selection-reply.tsx";
import { EventLine, NoteItem, useEventLines } from "./activity.tsx";
import { AddedLine, MessageItem, PendingItem } from "./message.tsx";
import { Properties, SNOOZES } from "./properties.tsx";
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
  const single = isSingleEmail(thread, pending.length, shared ? helpdesk : undefined);
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
      <Actions thread={thread} shared={shared} />
      {/* The divider from the list runs beside the messages only; the toolbar row stays open,
          continuing the list's header row. */}
      {/* Per conversation: the timeline's menus and selections steer the composer under it. */}
      <ComposerProvider key={threadId} chat={shared}>
        <SelectionReply threadId={threadId} />
        <div
          ref={scroller}
          onScroll={onScroll}
          // Full screen, the sidebar's own edge is the only line: a second beside it doubles up.
          className={`${SCROLLER} overflow-y-auto overscroll-none ${fullScreen ? "" : "border-s"}`}
        >
          {/* A single email's title is a row of its own, as tall as a list row with the same
              bottom edge, so it lines up with the row it was opened from. */}
          {single && <TitleRow subject={subject} />}
          {/* Grows to fill a short thread, so the composer stays at the pane's bottom. */}
          <div className={single ? PAGE : COLUMN}>
            <ColumnHead subject={subject} thread={thread} shared={shared} single={single} />
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
            <ReplyComposer thread={thread} />
          </div>
        </div>
      </ComposerProvider>
    </section>
  );
}

/**
 * A single email's title, on one line: as tall as a list row, with the same bottom edge. It stays
 * at the pane's top, filled, so the email scrolls under it.
 */
function TitleRow({ subject }: { subject: string }) {
  return (
    <div className="sticky top-0 z-10 flex h-13.25 shrink-0 items-center border-b bg-background px-5">
      <Heading level={2} className="truncate" title={subject || undefined}>
        {subject || "(no subject)"}
      </Heading>
    </div>
  );
}

/**
 * The top of the messages: a conversation's title, and on a shared inbox what it is (status,
 * owner, priority, tags). A single email's title is its row above, so only the properties stay.
 */
function ColumnHead(props: { subject: string; thread: Thread; shared: boolean; single: boolean }) {
  if (props.single && !props.shared) return null;
  return (
    <div className="flex flex-col gap-2">
      {!props.single && <Heading level={2}>{props.subject || "(no subject)"}</Heading>}
      {props.shared && (
        <div className="mt-2">
          <Properties thread={props.thread} />
        </div>
      )}
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
// A single email: the column without its width cap, under its title row.
const PAGE = "flex w-full grow flex-col gap-6 px-5 pt-5 pb-6";

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
            {/* The toolbar's actions: 28px buttons with 16px icons, as `Actions` lays them out. */}
            <div className="flex h-10.5 shrink-0 items-center justify-end gap-3 border-s border-b border-s-transparent pe-3 pb-0.5">
              {[0, 1, 2, 3].map((i) => (
                <SkeletonBox key={i} width={16} height={16} radius={4} />
              ))}
            </div>
            <div className={`${SCROLLER} overflow-hidden border-s`}>
              <div className={COLUMN}>
                <SkeletonBox width="45%" height={20} />
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
  const lines = useEventLines(mailboxId, helpdesk?.events ?? []);
  const entries: { at: string; key: string; node: ReactNode }[] = [
    ...messages.map((message) => ({
      at: message.sentAt,
      key: message.id,
      node: (
        <>
          <AddedLine message={message} />
          <MessageItem threadId={threadId} message={message} self={mailboxAddress} flat={flat} />
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

/** Back to the list: the thread route's parent, same search. */
function useCloseThread() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    const path = location.pathname.slice(0, location.pathname.lastIndexOf("/"));
    void navigate({ href: path + location.searchStr });
  };
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
 * The actions at the right of the bar over the conversation. A shared inbox's conversation is
 * resolved or snoozed for the whole team; a personal thread keeps archive, done and later
 * (ADR 0007). Read state and full screen in both.
 */
function Actions({ thread, shared }: { thread: Thread; shared: boolean }) {
  const markRead = useMarkRead();
  const [fullScreen, toggleFullScreen] = useFullScreen();

  return (
    // pb-0.5 lifts the icons 1px, in line with the list's header row beside it; end-1.5
    // matches the 28px buttons' inset from the top.
    // Full screen, the bottom line runs straight into the sidebar's edge, with no notch.
    <div
      className={`relative flex h-10.5 shrink-0 items-center border-b pb-0.5 ${fullScreen ? "" : "border-s border-s-transparent"}`}
    >
      {/* Full screen hides the list: switch threads from here. 12px in, the label at 20px like
          the list's rows. */}
      {fullScreen && (
        <div className="absolute inset-y-0 start-3 flex max-w-[40%] items-center pb-0.5">
          <ThreadSwitcher threadId={thread.id} />
        </div>
      )}
      <div className="absolute inset-y-0 end-1.5 flex items-center gap-1 pb-0.5">
        {shared ? (
          <>
            <HelpdeskActions threadId={thread.id} />
            <TriageActions thread={thread} />
          </>
        ) : (
          <MailActions thread={thread} />
        )}
        <Action
          label={thread.read ? "Mark unread" : "Mark read"}
          onPress={() => markRead.mutate({ threadId: thread.id, read: !thread.read })}
        >
          {thread.read ? <IconMail /> : <IconMailOpen />}
        </Action>
        <Action label={fullScreen ? "Side by side" : "Full screen"} onPress={toggleFullScreen}>
          {fullScreen ? <IconMinimize /> : <IconMaximize />}
        </Action>
      </div>
    </div>
  );
}

/** Resolve (or reopen) and snooze, for everyone on the inbox. Each offers undo. */
function HelpdeskActions({ threadId }: { threadId: string }) {
  const { data: conversation } = useConversation(threadId);
  const resolve = useResolve();
  const reopen = useReopen();
  const snooze = useSnooze();
  const resolved = conversation?.status === "resolved";
  const close = useCloseThread();
  return (
    <>
      <Action
        label={resolved ? "Reopen" : "Resolve"}
        onPress={() => {
          if (resolved) return reopen.mutate({ threadId });
          // Done with it: it leaves the inbox, and the reader goes back to the list.
          resolve.mutate({ threadId });
          close();
        }}
      >
        {resolved ? <IconCircle /> : <IconCircleCheck />}
      </Action>
      <MenuTrigger>
        <TooltipTrigger delay={400}>
          {/* The team's snooze, apart from your own Later (a plain clock) beside it. */}
          <Button intent="ghost" size="sq-sm-lg" aria-label="Snooze">
            <IconClockSnooze />
          </Button>
          <Tooltip>Snooze</Tooltip>
        </TooltipTrigger>
        <Menu placement="bottom end">
          {SNOOZES.map(({ label, until }) => (
            <MenuItem
              key={label}
              textValue={label}
              onAction={() => snooze.mutate({ threadId, until: until() })}
            >
              <IconClockSnooze data-slot="icon" />
              <MenuLabel>{label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </>
  );
}

/** A personal thread's own actions (ADR 0007, ADR 0027): archive, then done and later. */
function MailActions({ thread }: { thread: Thread }) {
  const archive = useArchive();
  return (
    <>
      <Action label="Archive" onPress={() => archive.mutate({ threadId: thread.id })}>
        <IconArchive />
      </Action>
      <TriageActions thread={thread} />
    </>
  );
}

/**
 * Done and Later, which act for you alone, on a personal thread and on a shared conversation
 * alike (ADR 0031): on a shared inbox they leave the team's status as it is.
 */
function TriageActions({ thread }: { thread: Thread }) {
  const threadId = thread.id;
  const moveToLater = useMoveToLater();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  return (
    <>
      <Action
        label={thread.done ? "Not done" : "Done"}
        onPress={() =>
          thread.done
            ? markUndone.mutate({ threadId })
            : markDone.mutate({ threadId, through: thread.lastMessageAt })
        }
      >
        {thread.done ? <IconInbox /> : <IconCheck />}
      </Action>
      <Action
        label={thread.later ? "Back to inbox" : "Later"}
        onPress={() => moveToLater.mutate({ threadId, later: !thread.later })}
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
