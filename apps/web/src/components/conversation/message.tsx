import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { IconMail, IconNote } from "@/components/icons/central";
import { MenuItem, MenuLabel } from "@/components/ui/menu";
import type { PendingSend } from "@/lib/pending.ts";
import type { Message } from "@/lib/types.ts";
import { AttachmentChips } from "./attachments.tsx";
import { REPLY_SOURCE } from "../compose/selection-reply.tsx";
import { FullMessage } from "./full-message.tsx";
import { MessageMenu } from "./message-menu.tsx";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Today's messages show the time; older ones the day as well. */
export function messageTime(iso: string) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return (today ? TIME : DAY_TIME).format(date);
}

const personName = (p: { name?: string | null; address: string }) => p.name || p.address;

function list(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Ana added Luis and Bea." (spec "Rendering rules"). */
export function AddedLine({ message }: { message: Message }) {
  if (!message.addedParticipants.length) return null;
  const who = message.fromMe
    ? "You"
    : personName({ name: message.fromName, address: message.fromAddress });
  return (
    // 8px more above and below than the timeline's gap, so a quiet line breathes between bubbles.
    <p className="py-2 text-center text-xs text-subtle-foreground">
      {who} added {list(message.addedParticipants.map(personName))}.
    </p>
  );
}

/**
 * One message in the conversation. Short ones are chat bubbles (the team's on the right: yours
 * blue, a teammate's grey), long or
 * formal ones are cards (`display`, decided by the Worker). Either can open the full message: the
 * sender's HTML in a sandboxed frame, for when reply stripping got it wrong. A message with no
 * text of its own (an HTML-only mail the stripper emptied) opens that way.
 */
export function MessageItem({ threadId, message }: { threadId: string; message: Message }) {
  const [full, setFull] = useState(opensFull(message));
  const sender = personName({ name: message.fromName, address: message.fromAddress });
  const card = message.display === "card" || full;
  // Right-hand side: anything this inbox sent. Blue only for the reader's own replies.
  const ours = message.fromTeam && !card;

  // In the ⋯ menu: the sender's layout, or the text Omni drew from it.
  const toggle = message.hasHtml && (
    <MenuItem
      textValue={full ? "Show text" : "Show full message"}
      onAction={() => setFull((open) => !open)}
    >
      {full ? <IconNote data-slot="icon" /> : <IconMail data-slot="icon" />}
      <MenuLabel>{full ? "Show text" : "Show full message"}</MenuLabel>
    </MenuItem>
  );

  return (
    <article
      aria-label={`${message.fromMe ? "You" : sender}, ${messageTime(message.sentAt)}`}
      className={`group/item flex flex-col gap-3 ${ours ? "items-end" : "items-start"}`}
    >
      <header className="flex items-center gap-2">
        {!message.fromMe && (
          <Avatar
            isSquare
            size="xs"
            initials={sender.slice(0, 1).toUpperCase()}
            // 18px, as on notes: a step under xs, so the face sits with the 14px name.
            className="bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.5)]"
          />
        )}
        <span className="text-sm">{message.fromMe ? "You" : sender}</span>
        <time dateTime={message.sentAt} className="text-xs text-subtle-foreground tabular-nums">
          {messageTime(message.sentAt)}
        </time>
        <MessageMenu
          start={ours}
          label="Message actions"
          from={sender}
          text={message.cleanText}
          messageId={message.id}
          extra={toggle}
        />
      </header>

      {card ? (
        <div
          {...{ [REPLY_SOURCE]: sender }}
          className="flex w-full flex-col gap-3 rounded-xl border bg-background p-4 shadow-(--shadow-raised)"
        >
          {!full && <Body loose text={message.cleanText} />}
          {full && <FullMessage threadId={threadId} messageId={message.id} />}
        </div>
      ) : (
        <>
          <div
            {...{ [REPLY_SOURCE]: sender }}
            className={`max-w-[80%] rounded-xl px-3 py-2 ${
              ours && message.fromMe
                ? "bg-primary-subtle text-foreground"
                : "bg-accent text-foreground"
            }`}
          >
            <Body text={message.cleanText} />
          </div>
        </>
      )}

      <AttachmentChips
        threadId={threadId}
        attachments={message.attachments}
        align={ours ? "end" : "start"}
      />
    </article>
  );
}

/**
 * Opens as the sender laid it out: mail with no text of its own (an HTML-only mail the stripper
 * emptied), and designed mail from outside (newsletters, receipts, alerts), which loads remote
 * images or names them in its text version (`[image: Google]`). Person-to-person mail reads as
 * text.
 */
function opensFull(message: Message) {
  if (!message.hasHtml) return false;
  if (!message.cleanText.trim()) return true;
  return !message.fromTeam && (message.remoteImageCount > 0 || /\[image: /.test(message.cleanText));
}

/** A reply sent from here that has not come back as a message yet. */
export function PendingItem({ send }: { send: PendingSend }) {
  // Queued: the outbox has it and the mail service will send it, even if this tab closes.
  const label =
    send.status === "failed"
      ? `Not sent${send.error ? `: ${send.error}` : ""}`
      : send.status === "queued"
        ? "Queued"
        : "Sending…";
  return (
    <article aria-label="You, sending" className="flex flex-col items-end gap-2">
      <div className="max-w-[80%] rounded-xl bg-primary-subtle px-3 py-2 text-foreground opacity-70">
        <Body text={send.text} />
      </div>
      <span
        className={`text-xs ${send.status === "failed" ? "text-danger-subtle-foreground" : "text-subtle-foreground"}`}
      >
        {label}
      </span>
    </article>
  );
}

/** Mail text as written: line breaks kept, long words and links wrapped. */
function Body({ text, loose }: { text: string; loose?: boolean }) {
  // Cards read like a letter, with more leading; bubbles stay tight like chat.
  return (
    <p className={`${loose ? "text-sm/6" : "text-sm/5"} break-words whitespace-pre-wrap`}>{text}</p>
  );
}
