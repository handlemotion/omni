import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import {
  IconCheck,
  IconClock3,
  IconInbox,
  IconMaximize,
  IconMinimize,
  IconX,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { PageNav, usePageNavShown } from "@/components/shell/page-nav";
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
  useMarkReadOnOpen,
  useMarkUndone,
  useMoveToLater,
} from "@/hooks/use-mail-actions.ts";
import type { Conversation as HelpdeskState, Message, Thread } from "@/lib/types.ts";
import { ChatDock } from "../compose/chat-composer.tsx";
import { ReplyComposer } from "../compose/composer.tsx";
import { ComposerProvider, useComposerState } from "../compose/composer-state.tsx";
import { FloatingReply } from "../compose/floating-actions.tsx";
import { SelectionReply } from "../compose/selection-reply.tsx";
import { EventLine, NoteItem, useEventLines } from "./activity.tsx";
import { FloatingPager, useReaderView, ViewToggle, type ReaderView } from "./email-view.tsx";
import { AddedLine, MessageItem, PendingItem, scrollToMessage } from "./message.tsx";
import { Properties } from "./properties.tsx";
import { ThreadSwitcher } from "./thread-switcher.tsx";

const FOLD_OVER = 12;
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
  const { data: helpdesk } = useConversation(threadId, { enabled: shared });
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
  const reader = useReaderView(threadId, thread, isSingleEmail(thread, pending.length, helpdesk));
  const single = reader.view === "email";
  const atBottom = useRef(true);

  const toEnd = () =>
    scroller.current?.scrollTo({ top: single ? 0 : scroller.current.scrollHeight });
  useLayoutEffect(() => {
    atBottom.current = true;
    toEnd();
  }, [threadId, reader.view, single ? reader.email?.id : undefined]);
  useLayoutEffect(() => {
    if (atBottom.current) toEnd();
  }, [thread?.messages.length, pending.length, helpdesk?.notes.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (error && !thread) throw error;
  if (!thread) return <ConversationSkeleton />;
  const subject = thread.messages.at(-1)?.subject || thread.messages[0]?.subject || "";

  return (
    <section aria-label="Conversation" className={SECTION}>
      <Actions thread={thread} subject={subject} />
      <ComposerProvider
        key={threadId}
        threadId={threadId}
        messages={thread.messages}
        chat={shared}
        chatOpen={!single}
        onStartChat={() => reader.setView("conversation")}
      >
        {shared && <PropertiesRow thread={thread} view={reader.view} onView={reader.setView} />}
        <SelectionReply threadId={threadId} />
        <div
          ref={scroller}
          onScroll={onScroll}
          className={`${SCROLLER} overflow-y-auto overscroll-none ${fullScreen ? "" : "border-s"}`}
        >
          <div className={columnClass(single)}>
            <Timeline
              key={threadId}
              threadId={threadId}
              mailboxId={thread.mailboxId}
              mailboxAddress={thread.mailboxAddress}
              messages={reader.shown}
              helpdesk={shared && !single ? helpdesk : undefined}
              flat={single}
            />
            {pending.map((send) => (
              <PendingItem key={send.key} send={send} />
            ))}
            {!single && <ReplyComposer thread={thread} />}
          </div>
          <Foot thread={thread} reader={single ? reader : undefined} />
        </div>
      </ComposerProvider>
    </section>
  );
}

function PropertiesRow(props: {
  thread: Thread;
  view: ReaderView;
  onView: (view: ReaderView) => void;
}) {
  const composer = useComposerState();
  return (
    <div className="flex h-13 shrink-0 items-center border-s border-b px-3">
      <Properties thread={props.thread}>
        <ViewToggle
          view={props.view}
          onChange={(view) => (view === "conversation" ? composer.startChat() : props.onView(view))}
        />
      </Properties>
    </div>
  );
}

function Foot({
  thread,
  reader,
}: {
  thread: Thread;
  reader: { index: number; email: Message | undefined; move: (step: number) => void } | undefined;
}) {
  return (
    <div className="sticky bottom-0 w-full shrink-0">
      {reader && (
        <FloatingPager index={reader.index} count={thread.messages.length} onMove={reader.move} />
      )}
      <FloatingReply thread={thread} messageId={reader?.email?.id} />
      {reader && <ReplyComposer thread={thread} docked />}
      <ChatDock thread={thread} />
    </div>
  );
}

function isSingleEmail(
  thread: Thread | undefined,
  pending: number,
  helpdesk: HelpdeskState | undefined,
) {
  return thread?.messages.length === 1 && !pending && !helpdesk?.notes.length;
}

const SECTION = "flex min-w-0 flex-1 flex-col";
const SCROLLER = "flex min-h-0 flex-1 flex-col";
const COLUMN = "mx-auto flex w-full max-w-3xl grow flex-col gap-6 px-5 pt-6 pb-10";
const PAGE = "flex w-full grow flex-col gap-6 px-5 pt-5 pb-6";

function columnClass(single: boolean) {
  return `${single ? PAGE : COLUMN} pb-20`;
}

function ConversationSkeleton() {
  return (
    <section aria-label="Conversation" className={SECTION}>
      <Skeleton
        loading
        label="Loading conversation"
        className={SECTION}
        skeleton={
          <>
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

function Timeline(props: {
  threadId: string;
  mailboxId: string;
  mailboxAddress: string;
  messages: Message[];
  helpdesk: HelpdeskState | undefined;
  flat?: boolean;
}) {
  const { threadId, mailboxId, mailboxAddress, messages, helpdesk, flat } = props;
  const [unfolded, setUnfolded] = useState(false);
  const show = (id: string) => {
    if (scrollToMessage(id)) return;
    setUnfolded(true);
    requestAnimationFrame(() => requestAnimationFrame(() => scrollToMessage(id)));
  };
  const lines = useEventLines(mailboxId, helpdesk?.events ?? []);
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
  return (
    <div className="-m-1.5 flex flex-col gap-3 p-1.5 [contain-intrinsic-size:auto_160px] [content-visibility:auto]">
      {children}
    </div>
  );
}

function Actions({ thread, subject }: { thread: Thread; subject: string }) {
  const [fullScreen, toggleFullScreen] = useFullScreen();
  const pageNav = usePageNavShown();
  const navigate = useNavigate();
  const closeHref = useOpenList()?.closeHref;

  return (
    <div
      className={`flex h-12 shrink-0 items-center gap-3 border-b pe-2.5 ${fullScreen && pageNav ? "ps-2.5" : "ps-5"} ${fullScreen ? "" : "border-s"}`}
    >
      {fullScreen && <PageNav />}
      {fullScreen && (
        <div className="-ms-2 flex max-w-[40%] shrink-0 items-center">
          <ThreadSwitcher threadId={thread.id} />
        </div>
      )}
      <Heading level={2} className="min-w-0 flex-1 text-md" title={subject || undefined}>
        <MiddleTruncate text={subject || "(no subject)"} />
      </Heading>
      <div className="flex shrink-0 items-center gap-1">
        <TriageActions thread={thread} />
        <Action label={fullScreen ? "Side by side" : "Full screen"} onPress={toggleFullScreen}>
          {fullScreen ? <IconMinimize /> : <IconMaximize />}
        </Action>
        {closeHref && (
          <Action label="Close" onPress={() => void navigate({ href: closeHref })}>
            <IconX />
          </Action>
        )}
      </div>
    </div>
  );
}

function TriageActions({ thread }: { thread: Thread }) {
  const threadId = thread.id;
  const moveToLater = useMoveToLater();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
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
      <Button intent="ghost" size="sq-sm" aria-label={props.label} onPress={props.onPress}>
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}
