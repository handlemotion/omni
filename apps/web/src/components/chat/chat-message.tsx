import { useState, type ReactNode } from "react";
import { IconEllipsis } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuTrigger } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { replyLabel, type Reply } from "@/lib/reply.ts";
import { messageTime } from "../conversation/message.tsx";

/** Muted beside other actions; in a chat line, hidden until the message is hovered or focused. */
export function menuButtonClass(props: { visible?: boolean; island?: boolean; start?: boolean }) {
  const shown = props.visible || props.island;
  return [
    shown ? "text-muted-foreground hover:text-foreground" : "-my-0.5",
    props.start ? "order-first" : "",
    props.island ? "before:min-w-0" : "",
    shown
      ? ""
      : "opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100",
  ].join(" ");
}

/** A chat line's ⋯: shown on hover or focus (always on touch screens), its items as children. */
export function ChatMenu(props: { label: string; start?: boolean; children: ReactNode }) {
  return (
    <MenuTrigger>
      <Button
        intent="ghost"
        size="sq-2xs"
        aria-label={props.label}
        className={menuButtonClass(props)}
      >
        <IconEllipsis />
      </Button>
      <Menu placement="bottom end">{props.children}</Menu>
    </MenuTrigger>
  );
}

/** A person's face at the size of the name beside it. */
export function ChatFace({ name, src }: { name: string; src?: string | null | undefined }) {
  return (
    <Avatar
      isSquare
      size="xs"
      src={src}
      initials={name.slice(0, 1).toUpperCase()}
      className="bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.5)]"
    />
  );
}

export function ChatMessage(props: {
  /** For screen readers: who wrote it and when. */
  label: string;
  name: string;
  /** Before the name; none on your own messages on the right. */
  face?: ReactNode;
  /** After the name: a quiet tag ("Hidden"). */
  tag?: ReactNode;
  createdAt: string;
  edited?: boolean;
  /** The ⋯, or nothing while it cannot be acted on. */
  menu?: ReactNode;
  /** The passage it answers: quoted at the top of the bubble, behind a bar (not while editing). */
  reply?: Reply | undefined;
  /** `end` for the team's side (notes), `start` for a conversation among equals. */
  align: "start" | "end";
  /** Dotted with no fill: hidden from someone. Else a plain outlined bubble. */
  dashed?: boolean;
  /** Still on its way: dimmed. */
  pending?: boolean;
  /** The bubble takes the full width for its field. */
  editing?: boolean;
  /** Marks the bubble as a source a selection can reply to. */
  bubbleProps?: Record<string, string>;
  children: ReactNode;
}) {
  const end = props.align === "end";
  return (
    <article
      aria-label={props.label}
      className={`group/item flex flex-col gap-3 ${end ? "items-end" : "items-start"}`}
    >
      <header className="flex max-w-full min-w-0 items-center gap-2">
        {props.face}
        <span className="truncate text-sm">{props.name}</span>
        {props.tag}
        <time
          dateTime={props.createdAt}
          className="shrink-0 text-xs text-subtle-foreground tabular-nums"
        >
          {messageTime(props.createdAt)}
          {props.edited && " · edited"}
        </time>
        {props.menu}
      </header>
      <div
        {...props.bubbleProps}
        className={`rounded-xl border px-3 py-2 text-foreground ${
          props.dashed ? "border-dashed border-muted-foreground/40" : "border-border"
        } ${props.editing ? "w-full" : "max-w-[80%]"} ${props.pending ? "opacity-70" : ""}`}
      >
        {props.reply && !props.editing && <ChatQuote reply={props.reply} />}
        {props.children}
      </div>
    </article>
  );
}

/**
 * The passage a message answers, at the top of its bubble: a 2px bar, then who wrote it and what,
 * muted and cut to two lines (the whole passage on hover).
 */
export function ChatQuote({ reply }: { reply: Reply }) {
  return (
    <p
      title={reply.text}
      className="mb-1 line-clamp-2 border-s-2 border-border ps-2 text-sm/5 break-words text-muted-foreground"
    >
      {reply.from}: {replyLabel(reply)}
    </p>
  );
}

/** Plain text as a bubble shows it: line breaks kept, long words broken. */
export function ChatText({ children }: { children: ReactNode }) {
  return <p className="text-sm/5 break-words whitespace-pre-wrap">{children}</p>;
}

/**
 * A message's words being edited, inside its bubble: ⌘/Ctrl+Enter saves, Esc cancels. Saving
 * the same words, or none, only closes it.
 */
export function ChatEdit(props: {
  label: string;
  text: string;
  onSave: (text: string) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(props.text);
  const save = () => {
    const next = text.trim();
    if (next && next !== props.text) props.onSave(next);
    props.onDone();
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        plain
        autoFocus
        aria-label={props.label}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") props.onDone();
        }}
        className="max-h-[40vh] resize-none py-0 sm:py-0"
      />
      <div className="flex justify-end gap-1">
        <Button intent="plain" size="sm" onPress={props.onDone}>
          Cancel
        </Button>
        <Button size="sm" isDisabled={!text.trim()} onPress={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
