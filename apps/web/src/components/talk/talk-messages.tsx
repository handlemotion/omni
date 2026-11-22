import { cn } from "cn";
import { Fragment, memo, startTransition, useCallback, useEffect, useState } from "react";
import { FileGlyph } from "@/components/storage/file-glyph";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useReact } from "@/hooks/use-talk.ts";
import { fileType } from "@/lib/file-kind.ts";
import { fileUrl, isImage, reacting, type TalkMessage } from "@/lib/talk.ts";
import { isPending } from "@/lib/talk-cache.ts";

const GAP_MS = 60 * 60_000;
const QUICK = ["👍", "❤️", "😂", "🎉"];

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const timeLine = (at: Date, now = new Date()) => {
  const time = timeFormat.format(at);
  if (at.toDateString() === now.toDateString()) return time;
  return `${dayFormat.format(at)}, ${time}`;
};

const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${Math.round(size / 1024)} KB`
      : `${(size / 1024 ** 2).toFixed(1)} MB`;

const typeOf = (name: string) => name.split(".").at(-1)?.toUpperCase() ?? "File";

type SetReaction = (messageId: string, emoji: string, on: boolean) => void;

function useToggle(message: TalkMessage, meId: string, react: SetReaction) {
  const has = (emoji: string) =>
    message.reactions.some((r) => r.emoji === emoji && r.memberIds.includes(meId));
  const set = (emoji: string, on: boolean) => {
    if (!isPending(message.id)) react(message.id, emoji, on);
  };
  return { has, set };
}

function useAfterPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => startTransition(() => setReady(true)), []);
  return ready;
}

interface NoteProps {
  message: TalkMessage;
  meId: string;
  react: SetReaction;
}

function Reactions(props: NoteProps & { mine: boolean }) {
  const { has, set } = useToggle(props.message, props.meId, props.react);
  if (props.message.reactions.length === 0) return null;
  return (
    <div
      className={cn(
        "relative z-10 -mt-2.5 flex max-w-full flex-wrap gap-0.5",
        props.mine ? "justify-end pe-2" : "justify-start ps-2",
      )}
    >
      {props.message.reactions.map((r) => (
        <Button
          key={r.emoji}
          intent="plain"
          size="text"
          isCircle
          aria-pressed={has(r.emoji)}
          aria-label={`${r.emoji} ${r.memberIds.length}`}
          onPress={() => set(r.emoji, !has(r.emoji))}
          className={cn(
            "h-6 gap-0.5 bg-background px-1.5 font-emoji text-sm tabular-nums shadow-overlay",
            has(r.emoji) && "ring-1 ring-primary/30",
          )}
        >
          {r.emoji}
          {r.memberIds.length > 1 && (
            <span className="font-sans text-xs text-muted-foreground">{r.memberIds.length}</span>
          )}
        </Button>
      ))}
    </div>
  );
}

function QuickReactions(props: NoteProps & { mine: boolean }) {
  const { has, set } = useToggle(props.message, props.meId, props.react);
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-7 z-20 flex rounded-full border border-border bg-background p-0.5 opacity-0 shadow-overlay transition-opacity duration-150",
        "group-hover/note:pointer-events-auto group-hover/note:opacity-100 group-focus-within/note:pointer-events-auto group-focus-within/note:opacity-100",
        props.mine ? "end-0" : "start-0",
      )}
    >
      {QUICK.filter((emoji) => !has(emoji)).map((emoji) => (
        <Button
          key={emoji}
          intent="ghost"
          size="sq-xs"
          isCircle
          aria-label={`React ${emoji}`}
          onPress={() => set(emoji, true)}
          className="font-emoji text-sm"
        >
          {emoji}
        </Button>
      ))}
    </span>
  );
}

function Attachment(props: { message: TalkMessage; mine: boolean }) {
  const file = props.message.file!;
  const href = file.nodeId ? fileUrl(props.message.id) : undefined;
  if (href && isImage(file.mimeType)) {
    return (
      <Link href={href} target="_blank" rel="noreferrer" className="block hover:opacity-90">
        <img
          src={href}
          alt={file.name}
          loading="lazy"
          className="block h-auto max-h-64 min-h-12 w-auto max-w-44 min-w-12 rounded-xl border border-border bg-secondary object-contain"
        />
      </Link>
    );
  }
  const chip = (
    <span
      className={cn(
        "flex max-w-56 min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5",
        props.mine ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
      )}
    >
      <span className="shrink-0 opacity-70 *:size-4">
        <FileGlyph kind={fileType(file.name, file.mimeType).kind} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm/5">{file.name}</span>
        <span className="truncate text-xs/4 opacity-70 tabular-nums">
          {typeOf(file.name)} • {bytes(file.size)}
        </span>
      </span>
    </span>
  );
  return href ? (
    <Link href={href} target="_blank" rel="noreferrer" className="block min-w-0 hover:opacity-90">
      {chip}
    </Link>
  ) : (
    <span className="block min-w-0 opacity-50">{chip}</span>
  );
}

const Note = memo(function Note(props: NoteProps & { tail: boolean }) {
  const { message } = props;
  const mine = message.authorMemberId === props.meId;
  const quick = useAfterPaint();
  return (
    <div
      className={cn(
        "group/note flex",
        mine ? "justify-end ps-14" : "justify-start pe-14",
        props.tail && "mb-2.5",
      )}
    >
      <div
        className={cn("relative flex min-w-0 flex-col gap-0.5", mine ? "items-end" : "items-start")}
      >
        {quick && <QuickReactions {...props} mine={mine} />}
        {message.body && (
          <p
            className={cn(
              "max-w-full rounded-xl px-2.5 py-1 text-sm/5 break-words whitespace-pre-wrap",
              mine ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
            )}
          >
            {message.body}
          </p>
        )}
        {message.file && <Attachment message={message} mine={mine} />}
        <Reactions {...props} mine={mine} />
      </div>
    </div>
  );
});

/** A thread's notes as bubbles, oldest first, a time line wherever an hour passes. */
export function TalkMessages(props: { messages: TalkMessage[]; meId: string; threadId: string }) {
  const { mutate } = useReact(props.threadId);
  const { meId } = props;
  const react = useCallback<SetReaction>(
    (messageId, emoji, on) => mutate(reacting({ messageId, emoji, on, meId })),
    [mutate, meId],
  );
  const ordered = props.messages.toReversed();
  return (
    <div className="flex flex-col gap-1 px-3.5 pt-3 pb-4">
      {ordered.map((message, i) => {
        const before = ordered[i - 1];
        const after = ordered[i + 1];
        const at = Date.parse(message.createdAt);
        const newHour = !before || at - Date.parse(before.createdAt) > GAP_MS;
        const tail = !!after && after.authorMemberId !== message.authorMemberId;
        return (
          <Fragment key={message.id}>
            {newHour && (
              <p className="pt-1 pb-2.5 text-center text-xs text-muted-foreground tabular-nums">
                {timeLine(new Date(at))}
              </p>
            )}
            <Note message={message} meId={meId} tail={tail} react={react} />
          </Fragment>
        );
      })}
    </div>
  );
}
