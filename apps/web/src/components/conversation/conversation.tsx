import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  IconArchive,
  IconCheck,
  IconClock3,
  IconInbox,
  IconMail,
  IconMailOpen,
  IconMaximize,
  IconMinimize,
} from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { ShowMore } from "@/components/ui/show-more";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useMailboxes, useThread } from "@/hooks/use-mail.ts";
import {
  useArchive,
  useDefer,
  useMarkDone,
  useMarkRead,
  useMarkReadOnOpen,
  useMarkUndone,
} from "@/hooks/use-mail-actions.ts";
import { DEFER_MS, isDeferred } from "@/lib/threads.ts";
import type { Message, Thread } from "@/lib/types.ts";
import { ReplyComposer } from "../compose/composer.tsx";
import { AddedLine, MessageItem, PendingItem } from "./message.tsx";
import { Properties } from "./properties.tsx";

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
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Whether the reader sat at the bottom before this render: new mail follows them only then.
  const atBottom = useRef(true);

  // A conversation opens at its newest message, like a chat.
  useLayoutEffect(() => {
    atBottom.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }, [threadId]);
  // A new message or reply keeps the newest in view, unless they scrolled up to read.
  useLayoutEffect(() => {
    if (atBottom.current) end.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, pending.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!thread) return null; // The route loader fetched it.
  const subject = thread.messages.at(-1)?.subject || thread.messages[0]?.subject || "";

  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col">
      <Actions thread={thread} />
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
          <div className="flex flex-col gap-2">
            <Heading level={2}>{subject || "(no subject)"}</Heading>
            {thread.summary && <p className="text-sm/6 text-muted-foreground">{thread.summary}</p>}
          </div>
          <Timeline key={threadId} threadId={threadId} messages={thread.messages} />
          {pending.map((send) => (
            <PendingItem key={send.key} send={send} />
          ))}
          <ReplyComposer thread={thread} />
          <div ref={end} />
        </div>
      </div>
    </section>
  );
}

/**
 * The messages. A long thread folds its middle until asked, so a hundred-message thread mounts
 * ten; each message also skips layout and paint while off screen (`content-visibility`).
 */
function Timeline({ threadId, messages }: { threadId: string; messages: Message[] }) {
  const [unfolded, setUnfolded] = useState(false);
  const fold = !unfolded && messages.length > FOLD_OVER;
  const head = fold ? messages.slice(0, KEEP_FIRST) : messages;
  const tail = fold ? messages.slice(-KEEP_LAST) : [];
  const hidden = messages.length - head.length - tail.length;

  const render = (message: Message) => (
    <Entry key={message.id}>
      <AddedLine message={message} />
      <MessageItem threadId={threadId} message={message} />
    </Entry>
  );
  return (
    <>
      {head.map(render)}
      {fold && (
        <ShowMore isSelected={false} onChange={() => setUnfolded(true)}>
          {hidden} earlier messages
        </ShowMore>
      )}
      {tail.map(render)}
    </>
  );
}

function Entry({ children }: { children: ReactNode }) {
  // Off-screen messages keep a guessed height instead of laying out; `auto` remembers the real
  // one once seen, so scrolling back does not jump.
  return (
    <div className="flex flex-col gap-3 [contain-intrinsic-size:auto_160px] [content-visibility:auto]">
      {children}
    </div>
  );
}

/** Archive, done, defer, read state and full screen, at the right of the bar over the conversation. */
function Actions({ thread }: { thread: Thread }) {
  const threadId = thread.id;
  const archive = useArchive();
  const markRead = useMarkRead();
  const defer = useDefer();
  const markDone = useMarkDone();
  const markUndone = useMarkUndone();
  const deferred = isDeferred(thread.deferredUntil);
  const [fullScreen, toggleFullScreen] = useFullScreen();
  const shared = useMailboxes().data?.find((m) => m.id === thread.mailboxId)?.kind === "shared";

  return (
    // pb-0.5 lifts the icons 1px, in line with the list's header row beside it; pe-1.5
    // matches the 28px buttons' inset from the top.
    <div className="@container flex h-10.5 shrink-0 items-center gap-1 border-b ps-1.5 pe-1.5 pb-0.5">
      {shared && <Properties thread={thread} />}
      <span className="flex-1" />
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
      <Action
        label={thread.read ? "Mark unread" : "Mark read"}
        onPress={() => markRead.mutate({ threadId, read: !thread.read })}
      >
        {thread.read ? <IconMail /> : <IconMailOpen />}
      </Action>
      <Action label={fullScreen ? "Side by side" : "Full screen"} onPress={toggleFullScreen}>
        {fullScreen ? <IconMinimize /> : <IconMaximize />}
      </Action>
    </div>
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
