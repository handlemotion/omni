import { useLocation, useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconCheck,
  IconCircle,
  IconCircleCheck,
  IconClock3,
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
  useDefer,
  useMarkDone,
  useMarkRead,
  useMarkReadOnOpen,
  useMarkUndone,
} from "@/hooks/use-mail-actions.ts";
import { DEFER_MS, isDeferred } from "@/lib/threads.ts";
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
 * The open conversation beside the list: its actions, subject and AI summary, then the messages
 * oldest first, ending at the newest with the reply box under it.
 */
export function Conversation({ threadId }: { threadId: string }) {
  const { thread, pending } = useThread(threadId);
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
  const scroller = useRef<HTMLDivElement>(null);
  // Whether the reader sat at the bottom before this render: new mail follows them only then.
  const atBottom = useRef(true);

  // To the very end, so the newest message sits above the composer floating over it.
  const toEnd = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
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

  if (!thread) return null; // The route loader fetched it.
  const subject = thread.messages.at(-1)?.subject || thread.messages[0]?.subject || "";

  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
      <Actions thread={thread} shared={shared} />
      {/* The divider from the list runs beside the messages only; the toolbar row stays open,
          continuing the list's header row. */}
      {/* Per conversation: the timeline's menus and selections steer the composer under it. */}
      <ComposerProvider key={threadId} chat={shared}>
        <SelectionReply threadId={threadId} />
        <div
          ref={scroller}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none border-s"
        >
          {/* Grows to fill a short thread, so the composer still floats at the bottom. The bottom
              padding clears the fade, so the newest message ends above it. */}
          <div className="mx-auto flex w-full max-w-3xl grow flex-col gap-6 px-5 pt-6 pb-10">
            <div className="flex flex-col gap-2">
              <Heading level={2}>{subject || "(no subject)"}</Heading>
              {/* What the conversation is (status, owner, priority, tags) sits with its title. */}
              {shared && (
                <div className="mt-2">
                  <Properties thread={thread} />
                </div>
              )}
              {thread.summary && (
                <p className="text-sm/6 text-muted-foreground">{thread.summary}</p>
              )}
            </div>
            <Timeline
              key={threadId}
              threadId={threadId}
              mailboxId={thread.mailboxId}
              messages={thread.messages}
              helpdesk={shared ? helpdesk : undefined}
            />
            {pending.map((send) => (
              <PendingItem key={send.key} send={send} />
            ))}
          </div>
          {/* Floats 16px off the bottom, in the messages' column; they scroll behind it and fade
              out as they reach it. */}
          <div className="sticky bottom-0 mx-auto w-full max-w-3xl shrink-0 px-5 pb-4">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-b from-transparent to-background to-[2.5rem]"
            />
            <div className="relative">
              <ReplyComposer thread={thread} />
            </div>
          </div>
        </div>
      </ComposerProvider>
    </section>
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
  messages: Message[];
  helpdesk: HelpdeskState | undefined;
}) {
  const { threadId, mailboxId, messages, helpdesk } = props;
  const [unfolded, setUnfolded] = useState(false);
  const lines = useEventLines(mailboxId, helpdesk?.events ?? []);
  const entries: { at: string; key: string; node: ReactNode }[] = [
    ...messages.map((message) => ({
      at: message.sentAt,
      key: message.id,
      node: (
        <>
          <AddedLine message={message} />
          <MessageItem threadId={threadId} message={message} />
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
  // so 4px of padding (taken back by the margin) leaves room for the header's ⋯ button, which
  // reaches above the article.
  return (
    <div className="-mt-1 flex flex-col gap-3 pt-1 [contain-intrinsic-size:auto_160px] [content-visibility:auto]">
      {children}
    </div>
  );
}

/**
 * The actions at the right of the bar over the conversation. A shared inbox's conversation is
 * resolved or snoozed for the whole team; a personal thread keeps archive, done and defer
 * (ADR 0007). Read state and full screen in both.
 */
function Actions({ thread, shared }: { thread: Thread; shared: boolean }) {
  const markRead = useMarkRead();
  const [fullScreen, toggleFullScreen] = useFullScreen();

  return (
    // pb-0.5 lifts the icons 1px, in line with the list's header row beside it; end-1.5
    // matches the 28px buttons' inset from the top.
    <div className="relative flex h-10.5 shrink-0 items-center border-s border-b border-s-transparent pb-0.5">
      {/* Full screen hides the list: switch threads from here. 12px in, the label at 20px like
          the list's rows. */}
      {fullScreen && (
        <div className="absolute inset-y-0 start-3 flex max-w-[40%] items-center pb-0.5">
          <ThreadSwitcher threadId={thread.id} />
        </div>
      )}
      <div className="absolute inset-y-0 end-1.5 flex items-center gap-1 pb-0.5">
        {shared ? <HelpdeskActions threadId={thread.id} /> : <MailActions thread={thread} />}
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
          <Button intent="ghost" size="sq-sm-lg" aria-label="Snooze">
            <IconClock3 />
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
              <IconClock3 data-slot="icon" />
              <MenuLabel>{label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </>
  );
}

/** A personal thread's own actions (ADR 0007): archive, done, defer a day. */
function MailActions({ thread }: { thread: Thread }) {
  const threadId = thread.id;
  const archive = useArchive();
  const defer = useDefer();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  const deferred = isDeferred(thread.deferredUntil);
  return (
    <>
      <Action label="Archive" onPress={() => archive.mutate({ threadId })}>
        <IconArchive />
      </Action>
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
        label={deferred ? "Back to inbox" : "Defer a day"}
        onPress={() =>
          defer.mutate({
            threadId,
            until: deferred ? null : new Date(Date.now() + DEFER_MS),
          })
        }
      >
        {deferred ? <IconInbox /> : <IconClock3 />}
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
