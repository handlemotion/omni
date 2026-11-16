import { type ReactNode, useState } from "react";
import { linkSegments } from "@omni/mail-core/links";
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
  IconMail,
  IconNote,
  IconReply,
} from "@/components/icons/central";
import { Link } from "@/components/ui/link";
import { MenuItem, MenuLabel } from "@/components/ui/menu";
import { Tag, TagGroup, TagList } from "@/components/ui/tag-group";
import { appToast } from "@/components/ui/toast";
import { Toolbar } from "@/components/ui/toolbar";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import type { PendingSend } from "@/lib/pending.ts";
import type { Message } from "@/lib/types.ts";
import { AttachmentChips } from "./attachments.tsx";
import { useComposerState } from "../compose/composer-state.tsx";
import { REPLY_SOURCE } from "../compose/selection-reply.tsx";
import { FullMessage } from "./full-message.tsx";
import { MessageMenu } from "./message-menu.tsx";
import { Unsubscribe } from "./unsubscribe.tsx";

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
  /** The message this one answers (its In-Reply-To), when it is in the thread. */
  repliedTo?: Message | undefined;
  /** Brings a message into view, unfolding the timeline first when it is folded away. */
  onShow?: ((messageId: string) => void) | undefined;
}) {
  const { threadId, message } = props;
  const [full, setFull] = useState(opensFull(message));
  const sender = personName({ name: message.fromName, address: message.fromAddress });
  const card = message.display === "card" || full || !!props.flat;
  // Right-hand side: anything this inbox sent. Blue only for the reader's own replies.
  const ours = message.fromTeam && !card;
  // Reply and Forward sit in the header of mail from outside the team (and a single email's).
  const inline = !!props.flat || !message.fromTeam;

  const toggle = message.hasHtml && (
    <HtmlMenuItems full={full} onToggle={() => setFull((open) => !open)} />
  );

  const menu = (
    <MessageMenu
      start={ours}
      label="Message actions"
      from={sender}
      text={message.cleanText}
      messageId={message.id}
      extra={toggle}
      inline={inline}
      // A single email's header shows Reply and Forward beside it: a hidden ⋯ would leave a gap.
      visible={!!props.flat}
      // Mail from outside the team keeps its ⋯ on the hover island with Reply and Forward.
      island={!props.flat && !message.fromTeam}
    />
  );

  return (
    <article
      id={messageAnchor(message.id)}
      aria-label={`${message.fromMe ? "You" : sender}, ${messageTime(message.sentAt)}`}
      // An email's body sits further under its larger header than a bubble under its name.
      className={`group/item relative flex flex-col ${props.flat ? "gap-4" : "gap-3"} ${ours ? "items-end" : "items-start"}`}
    >
      <MessageHeader
        flat={!!props.flat}
        message={message}
        sender={sender}
        self={props.self}
        menu={menu}
        unsubscribe={<Unsubscribe threadId={threadId} message={message} />}
      />

      {card ? (
        <div
          {...{ [REPLY_SOURCE]: sender }}
          // The sender's layout fills its card edge to edge, clipped to the card's corners; text
          // keeps the card's 16px padding.
          className={`flex w-full flex-col gap-3 bg-background ${props.flat ? "" : `rounded-xl border shadow-(--shadow-raised) ${full ? "overflow-hidden" : "p-4"}`}`}
        >
          {!full && <Body loose text={message.cleanText} />}
          {full && <FullMessage threadId={threadId} messageId={message.id} flat={props.flat} />}
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
      {message.fromTeam && <RepliedTo message={props.repliedTo} onShow={props.onShow} />}
    </article>
  );
}

/** In the ⋯ menu: the sender's layout or the text Omni drew from it. */
function HtmlMenuItems(props: { full: boolean; onToggle: () => void }) {
  const label = props.full ? "Show text" : "Show full message";
  return (
    <MenuItem textValue={label} onAction={props.onToggle}>
      {props.full ? <IconNote data-slot="icon" /> : <IconMail data-slot="icon" />}
      <MenuLabel>{label}</MenuLabel>
    </MenuItem>
  );
}

/** A single email's header, laid out like mail, or a conversation message's line. */
function MessageHeader(props: {
  flat: boolean;
  message: Message;
  sender: string;
  self: string;
  menu: ReactNode;
  /** List mail's Unsubscribe, on the sender's line. */
  unsubscribe: ReactNode;
}) {
  const { message, sender, menu, unsubscribe } = props;
  if (props.flat)
    return (
      <EmailHeader
        message={message}
        sender={sender}
        self={props.self}
        menu={menu}
        unsubscribe={unsubscribe}
      />
    );
  return (
    <ChatHeader
      message={message}
      sender={sender}
      menu={menu}
      actions={!message.fromTeam}
      unsubscribe={unsubscribe}
    />
  );
}

/** Where a message sits in the page, so another can point to it. */
const messageAnchor = (id: string) => `message-${id}`;

/** Scrolls a mounted message to the middle of the reader; false when it isn't mounted. */
export function scrollToMessage(id: string) {
  const el = document.getElementById(messageAnchor(id));
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  return !!el;
}

/**
 * Under a team email: the email it answered, by sender and time, so a reply in the linear thread
 * says which message it was for. Pressing it brings that message into view.
 */
function RepliedTo(props: {
  message: Message | undefined;
  onShow: ((messageId: string) => void) | undefined;
}) {
  const { message } = props;
  if (!message) return null;
  const sender = personName({ name: message.fromName, address: message.fromAddress });
  return (
    <Button
      intent="plain"
      size="text"
      onPress={() => (props.onShow ? props.onShow(message.id) : scrollToMessage(message.id))}
      // 6px between the arrow and the words; icon and text share one colour, and the 16px line
      // centres the 12px arrow on the text.
      className="gap-x-1.5 text-xs/4 [--btn-foreground:var(--color-subtle-foreground)] [--btn-icon-active:var(--color-foreground)] [--btn-icon:var(--color-subtle-foreground)] hover:[--btn-foreground:var(--color-foreground)]"
    >
      <IconReply />
      <span>
        Replied to {sender} · <span className="tabular-nums">{messageTime(message.sentAt)}</span>
      </span>
    </Button>
  );
}

/**
 * A conversation message's line: a small face (not for yours), the name and the time. Mail from
 * outside the team adds Reply and Forward at the far right, to answer that message by email.
 */
function ChatHeader(props: {
  message: Message;
  sender: string;
  menu: ReactNode;
  actions: boolean;
  unsubscribe: ReactNode;
}) {
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
      {props.unsubscribe}
      {props.actions ? <ActionIsland message={message} menu={props.menu} /> : props.menu}
    </header>
  );
}

/**
 * Mail from outside the team: Reply, Forward and ⋯ on one small island at the message's top
 * right, in line with its name, shown while the pointer is over the message or focus is in it
 * (always on touch screens). The island is the toolbar primitive: one tab stop, arrows between.
 */
function ActionIsland({ message, menu }: { message: Message; menu: ReactNode }) {
  return (
    <Toolbar
      aria-label="Message actions"
      // 22px tall (20px buttons, 1px in), 2px up: measured, that centres it on the name.
      className="absolute -top-0.5 end-0 z-10 gap-0.5 rounded-md bg-surface p-px opacity-0 transition-opacity duration-150 ease-out group-focus-within/item:opacity-100 group-hover/item:opacity-100 has-aria-expanded:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
    >
      <ReplyActions message={message} small />
      {menu}
    </Toolbar>
  );
}

/** Reply and Forward to one message: the email composer opens answering it. */
function ReplyActions({ message, small = false }: { message: Message; small?: boolean }) {
  const composer = useComposerState();
  return (
    <>
      <HeaderAction
        small={small}
        label="Reply"
        // A shared inbox writes to everyone outside the team by default.
        onPress={() => composer.openReply(composer.chat ? "replyAll" : "reply", message.id)}
      >
        <IconReply />
      </HeaderAction>
      <HeaderAction small={small} label="Forward" onPress={() => composer.forward(message.id)}>
        <IconForward />
      </HeaderAction>
    </>
  );
}

/**
 * A single email's sender, laid out like mail: a larger face, the name and time, and under them
 * whom it went to, which opens the full From, To, Cc and Date. Reply and Forward sit at the end,
 * beside the ⋯.
 */
function EmailHeader(props: {
  message: Message;
  sender: string;
  self: string;
  menu: ReactNode;
  unsubscribe: ReactNode;
}) {
  const { message, sender } = props;
  const [open, setOpen] = useState(false);
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
            {props.unsubscribe}
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
          <ReplyActions message={message} />
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

/** A 20px island button's hit area: the island's height, its own width, no overlap. */
const ISLAND_HIT = "before:min-w-0";

function HeaderAction(props: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  /** 20px, on a message's action island. */
  small?: boolean;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size={props.small ? "sq-2xs" : "sq-xs"}
        // Side by side on the island, a 44px hit area would cover the button before it: each
        // keeps the island's height and only its own width.
        aria-label={props.label}
        className={`text-muted-foreground hover:text-foreground ${props.small ? ISLAND_HIT : ""}`}
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

/** Mail text as written: line breaks kept, long words wrapped, web addresses clickable. */
function Body({ text, loose }: { text: string; loose?: boolean }) {
  // Cards read like a letter, with more leading; bubbles stay tight like chat.
  return (
    <p className={`${loose ? "text-sm/6" : "text-sm/5"} break-words whitespace-pre-wrap`}>
      {linkSegments(text).map((segment, index) =>
        segment.href ? (
          <Link
            // oxlint-disable-next-line react/no-array-index-key -- segments never reorder
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {segment.text}
          </Link>
        ) : (
          segment.text
        ),
      )}
    </p>
  );
}
