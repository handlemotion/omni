import { type ReactNode, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import {
  IconChevronDown,
  IconForward,
  IconImage,
  IconMail,
  IconNote,
  IconReply,
} from "@/components/icons/central";
import { MenuItem, MenuLabel } from "@/components/ui/menu";
import { Tag, TagGroup, TagList } from "@/components/ui/tag-group";
import { appToast } from "@/components/ui/toast";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { PendingSend } from "@/lib/pending.ts";
import type { Message } from "@/lib/types.ts";
import { AttachmentChips } from "./attachments.tsx";
import { useComposerState } from "../compose/composer-state.tsx";
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
const FULL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

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
export function MessageItem(props: {
  threadId: string;
  message: Message;
  /** The inbox's own address: it reads as "You" among the recipients. */
  self: string;
  /** The thread's only message, shown as the page: a card without its edge. */
  flat?: boolean | undefined;
}) {
  const { threadId, message } = props;
  const [full, setFull] = useState(opensFull(message));
  // Remote images stay blocked (spec: tracking pixels) until the reader loads them.
  const [images, setImages] = useState(false);
  const sender = personName({ name: message.fromName, address: message.fromAddress });
  const card = message.display === "card" || full || !!props.flat;
  // Right-hand side: anything this inbox sent. Blue only for the reader's own replies.
  const ours = message.fromTeam && !card;

  const toggle = message.hasHtml && (
    <HtmlMenuItems
      full={full}
      onToggle={() => setFull((open) => !open)}
      onLoadImages={full && !images && message.remoteImageCount > 0 ? () => setImages(true) : null}
    />
  );

  const menu = (
    <MessageMenu
      start={ours}
      label="Message actions"
      from={sender}
      text={message.cleanText}
      messageId={message.id}
      extra={toggle}
      // A single email's header shows Reply and Forward beside it: a hidden ⋯ would leave a gap.
      visible={!!props.flat}
    />
  );

  return (
    <article
      aria-label={`${message.fromMe ? "You" : sender}, ${messageTime(message.sentAt)}`}
      // An email's body sits further under its larger header than a bubble under its name.
      className={`group/item flex flex-col ${props.flat ? "gap-4" : "gap-3"} ${ours ? "items-end" : "items-start"}`}
    >
      {props.flat ? (
        <EmailHeader message={message} sender={sender} self={props.self} menu={menu} />
      ) : (
        <ChatHeader message={message} sender={sender} menu={menu} />
      )}

      {card ? (
        <div
          {...{ [REPLY_SOURCE]: sender }}
          className={`flex w-full flex-col gap-3 bg-background ${props.flat ? "" : "rounded-xl border p-4 shadow-(--shadow-raised)"}`}
        >
          {!full && <Body loose text={message.cleanText} />}
          {full && (
            <FullMessage
              threadId={threadId}
              messageId={message.id}
              images={images}
              flat={props.flat}
            />
          )}
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

/** In the ⋯ menu: the sender's layout or the text Omni drew from it, and its remote images. */
function HtmlMenuItems(props: {
  full: boolean;
  onToggle: () => void;
  /** Set while the full message shows and has remote images still blocked. */
  onLoadImages: (() => void) | null;
}) {
  const label = props.full ? "Show text" : "Show full message";
  return (
    <>
      <MenuItem textValue={label} onAction={props.onToggle}>
        {props.full ? <IconNote data-slot="icon" /> : <IconMail data-slot="icon" />}
        <MenuLabel>{label}</MenuLabel>
      </MenuItem>
      {props.onLoadImages && (
        <MenuItem textValue="Load images" onAction={props.onLoadImages}>
          <IconImage data-slot="icon" />
          <MenuLabel>Load images</MenuLabel>
        </MenuItem>
      )}
    </>
  );
}

/** A conversation message's line: a small face (not for yours), the name and the time. */
function ChatHeader(props: { message: Message; sender: string; menu: ReactNode }) {
  const { message, sender } = props;
  return (
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
      {props.menu}
    </header>
  );
}

/**
 * A single email's sender, laid out like mail: a larger face, the name and time, and under them
 * whom it went to, which opens the full From, To, Cc and Date. Reply and Forward sit at the end,
 * beside the ⋯.
 */
function EmailHeader(props: { message: Message; sender: string; self: string; menu: ReactNode }) {
  const { message, sender } = props;
  const [open, setOpen] = useState(false);
  const composer = useComposerState();
  const name = (a: { name?: string | null; address: string }) =>
    a.address.toLowerCase() === props.self.toLowerCase() ? "You" : personName(a);
  const recipients = [...message.to, ...message.cc].map(name);
  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex w-full items-center gap-3">
        <Avatar
          isSquare
          size="md"
          initials={sender.slice(0, 1).toUpperCase()}
          className="bg-accent text-foreground outline-0"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <div className="flex max-w-full items-baseline gap-2">
            <span className="truncate text-sm">{sender}</span>
            <time dateTime={message.sentAt} className="text-xs text-subtle-foreground tabular-nums">
              {messageTime(message.sentAt)}
            </time>
          </div>
          <Button
            intent="plain"
            size="text"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            onPress={() => setOpen((was) => !was)}
            // Grey through the button's own colour, which a text class would not override.
            className="max-w-full [--btn-foreground:var(--color-muted-foreground)] hover:[--btn-foreground:var(--color-foreground)]"
          >
            <span className="truncate">to {list(recipients) || "undisclosed recipients"}</span>
            <IconChevronDown className={open ? "rotate-180" : ""} />
          </Button>
        </div>
        {/* The three actions read as one group: closer to each other than to the name. */}
        <div className="flex items-center gap-1">
          <HeaderAction label="Reply" onPress={() => composer.openReply("reply")}>
            <IconReply />
          </HeaderAction>
          <HeaderAction label="Forward" onPress={() => composer.forward(message.id)}>
            <IconForward />
          </HeaderAction>
          {props.menu}
        </div>
      </header>
      {/* In by the face's 32px and the header's 12px gap: the rows start where the name does. */}
      {open && (
        <div className="ps-11">
          <Details message={message} name={name} />
        </div>
      )}
    </div>
  );
}

function HeaderAction(props: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-xs"
        aria-label={props.label}
        className="text-muted-foreground hover:text-foreground"
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

/** Who sent it and to whom, each on its own row, and when. */
function Details(props: {
  message: Message;
  name: (a: { name?: string | null; address: string }) => string;
}) {
  const { message } = props;
  const rows: [string, { name?: string | null; address: string }[]][] = [
    ["To", message.to],
    ["Cc", message.cc],
  ];
  return (
    <DescriptionList className="sm:grid-cols-[--spacing(20)_auto]">
      <DescriptionTerm>From</DescriptionTerm>
      {/* One line, name then address, so every row is the same height. */}
      <DescriptionDetails className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0">{message.fromName || message.fromAddress}</span>
        {message.fromName && (
          <span className="truncate text-muted-foreground">{message.fromAddress}</span>
        )}
      </DescriptionDetails>
      {rows
        .filter(([, people]) => people.length > 0)
        .map(([label, people]) => (
          <Row key={label} label={label}>
            {/* Out by the pill's 8px padding, so its text lines up with From's and Date's. */}
            <TagGroup aria-label={label} className="-ms-2">
              <TagList items={people.map((p) => ({ id: p.address, label: props.name(p) }))}>
                {(item) => <Recipient id={item.id} label={item.label} />}
              </TagList>
            </TagGroup>
          </Row>
        ))}
      <Row label="Date">
        <time dateTime={message.sentAt} className="tabular-nums">
          {FULL_DATE.format(new Date(message.sentAt))}
        </time>
      </Row>
    </DescriptionList>
  );
}

/** A recipient's pill: its address on hover, and a click copies it. */
function Recipient({ id, label }: { id: string; label: string }) {
  const copy = () =>
    navigator.clipboard.writeText(id).then(
      () => appToast.success("Address copied"),
      () => appToast.error("The address could not be copied."),
    );
  return (
    // The tooltip sits inside the pill: React Aria builds a tag list's items in a document of its
    // own, where a tooltip around the Tag cannot render.
    <Tag id={id} textValue={label} onAction={copy} className="cursor-pointer hover:bg-secondary">
      <TooltipTrigger delay={400}>
        <span>{label}</span>
        <Tooltip>{id}</Tooltip>
      </TooltipTrigger>
    </Tag>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails>{children}</DescriptionDetails>
    </>
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
