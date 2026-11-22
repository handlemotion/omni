import { carriesInvite, InviteCard } from "@/components/calendar/invite-card";
import { type ReactNode, useState } from "react";
import { linkSegments } from "@omni/mail-core/links";
import { SenderAvatar, byAddress } from "@/components/avatar/sender-avatar";
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
import { opensFull } from "@/lib/message-html.ts";
import type { PendingSend } from "@/lib/pending.ts";
import type { Message } from "@/lib/types.ts";
import { AttachmentChips } from "./attachments.tsx";
import { useComposerState } from "../compose/composer-state.tsx";
import { REPLY_SOURCE } from "../compose/selection-reply.tsx";
import { FullMessage } from "./full-message.tsx";
import { MessageMenu, useMessageContextMenu } from "./message-menu.tsx";
import { Unsubscribe } from "./unsubscribe.tsx";
import { useYourMailbox } from "@/hooks/use-mailbox-identity.ts";

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
    <p className="py-2 text-center text-xs text-subtle-foreground">
      {who} added {list(message.addedParticipants.map(personName))}.
    </p>
  );
}

/**
 * One message in the conversation, as a full-width row: the sender's avatar, name and address, who
 * it went to and its subject, the time at the end, then what they newly wrote, with a divider
 * under it. A single email (`flat`) is the page itself instead. Either can open the full message: the sender's
 * HTML in a sandboxed frame, for when reply stripping got it wrong. A message with no text of its
 * own (an HTML-only mail the stripper emptied) opens that way.
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

  const toggle = message.hasHtml && (
    <HtmlMenuItems full={full} onToggle={() => setFull((open) => !open)} />
  );

  const menu = (
    <MessageMenu
      label="Message actions"
      from={sender}
      text={message.cleanText}
      messageId={message.id}
      extra={toggle}
      inline
      visible={!!props.flat}
      island={!props.flat}
    />
  );
  const htmlLabel = full ? "Show text" : "Show full message";
  const contextMenu = useMessageContextMenu({
    label: "Message actions",
    from: sender,
    text: message.cleanText,
    messageId: message.id,
    extra: [
      message.hasHtml && {
        icon: full ? IconNote : IconMail,
        label: htmlLabel,
        onAction: () => setFull((open) => !open),
      },
    ],
  });
  const unsubscribe = <Unsubscribe threadId={threadId} message={message} />;
  const attachments = <AttachmentChips threadId={threadId} attachments={message.attachments} />;
  const label = `${message.fromMe ? "You" : sender}, ${messageTime(message.sentAt)}`;
  const invite = carriesInvite(message.attachments) && (
    <InviteCard threadId={threadId} messageId={message.id} />
  );

  if (props.flat)
    return (
      <article
        id={messageAnchor(message.id)}
        aria-label={label}
        className="group/item relative flex flex-col gap-4"
        {...contextMenu}
      >
        <EmailHeader
          message={message}
          sender={sender}
          self={props.self}
          menu={menu}
          unsubscribe={unsubscribe}
        />
        {invite}
        <div {...{ [REPLY_SOURCE]: sender }} className="flex w-full flex-col gap-3">
          {full ? (
            <FullMessage threadId={threadId} messageId={message.id} flat />
          ) : (
            <Body text={message.cleanText} />
          )}
        </div>
        {attachments}
      </article>
    );

  return (
    <article
      id={messageAnchor(message.id)}
      aria-label={label}
      className="group/item relative flex flex-col border-b"
      {...contextMenu}
    >
      <div className="flex w-full flex-col">
        <CardHeader
          message={message}
          sender={sender}
          self={props.self}
          menu={menu}
          unsubscribe={unsubscribe}
        />
        {invite && <div className={CARD_BODY}>{invite}</div>}
        {full ? (
          <div {...{ [REPLY_SOURCE]: sender }}>
            <FullMessage threadId={threadId} messageId={message.id} />
          </div>
        ) : (
          <div {...{ [REPLY_SOURCE]: sender }} className={CARD_BODY}>
            <Body text={message.cleanText} />
          </div>
        )}
        {message.attachments.length > 0 && <div className={CARD_BODY}>{attachments}</div>}
        {message.fromTeam && props.repliedTo && (
          <div className={CARD_BODY}>
            <RepliedTo message={props.repliedTo} onShow={props.onShow} />
          </div>
        )}
      </div>
    </article>
  );
}

const CARD_BODY = "pr-5 pb-4 pl-17 last:pb-5";

function HtmlMenuItems(props: { full: boolean; onToggle: () => void }) {
  const label = props.full ? "Show text" : "Show full message";
  return (
    <MenuItem textValue={label} onAction={props.onToggle}>
      {props.full ? <IconNote data-slot="icon" /> : <IconMail data-slot="icon" />}
      <MenuLabel>{label}</MenuLabel>
    </MenuItem>
  );
}

const messageAnchor = (id: string) => `message-${id}`;

/** Scrolls a mounted message to the middle of the reader; false when it isn't mounted. */
export function scrollToMessage(id: string) {
  const el = document.getElementById(messageAnchor(id));
  el?.scrollIntoView({ behavior: "smooth", block: "center" });
  return !!el;
}

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
      className="gap-x-1.5 text-xs/4 [--btn-foreground:var(--color-subtle-foreground)] [--btn-icon-active:var(--color-foreground)] [--btn-icon:var(--color-subtle-foreground)] hover:[--btn-foreground:var(--color-foreground)]"
    >
      <IconReply />
      <span>
        Replied to {sender} · <span className="tabular-nums">{messageTime(message.sentAt)}</span>
      </span>
    </Button>
  );
}

function CardHeader(props: {
  message: Message;
  sender: string;
  self: string;
  menu: ReactNode;
  unsubscribe: ReactNode;
}) {
  const { message, sender } = props;
  const name = useRecipientName(props.self);
  const lines = [
    message.fromName ? message.fromAddress : undefined,
    `To: ${list(message.to.map(name)) || "undisclosed recipients"}`,
    message.cc.length ? `Cc: ${list(message.cc.map(name))}` : undefined,
    message.subject ? `Subject: ${message.subject}` : undefined,
  ].filter((line): line is string => !!line);
  return (
    <header className="flex w-full items-start gap-4 px-5 pt-5 pb-3">
      <SenderAvatar
        isSquare
        size="md"
        who={byAddress(message.fromAddress)}
        name={sender}
        className="bg-accent text-foreground outline-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm">{sender}</span>
          {props.unsubscribe}
        </div>
        {lines.map((line) => (
          <span key={line} className="truncate text-xs/4.5 text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
      <div className="flex h-5 shrink-0 items-center gap-2">
        <Toolbar
          aria-label="Message actions"
          className="gap-0.5 bg-transparent p-0 inset-ring-0 opacity-0 transition-opacity duration-150 ease-out group-focus-within/item:opacity-100 group-hover/item:opacity-100 has-aria-expanded:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
        >
          <ReplyActions message={message} small />
          {props.menu}
        </Toolbar>
        <time dateTime={message.sentAt} className="text-xs text-subtle-foreground tabular-nums">
          {messageTime(message.sentAt)}
        </time>
      </div>
    </header>
  );
}

function useRecipientName(self: string) {
  const you = useYourMailbox({ address: self })?.label ?? "You";
  return (a: { name?: string | null; address: string }) =>
    a.address.toLowerCase() === self.toLowerCase() ? you : personName(a);
}

function ReplyActions({ message, small = false }: { message: Message; small?: boolean }) {
  const composer = useComposerState();
  return (
    <>
      <HeaderAction
        small={small}
        label="Reply"
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

function EmailHeader(props: {
  message: Message;
  sender: string;
  self: string;
  menu: ReactNode;
  unsubscribe: ReactNode;
}) {
  const { message, sender } = props;
  const [open, setOpen] = useState(false);
  const name = useRecipientName(props.self);
  const recipients = [...message.to, ...message.cc].map(name);
  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex w-full items-center gap-3">
        <SenderAvatar
          isSquare
          size="md"
          who={byAddress(message.fromAddress)}
          name={sender}
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
            className="max-w-full [--btn-foreground:var(--color-muted-foreground)] hover:[--btn-foreground:var(--color-foreground)]"
          >
            <span className="truncate">to {list(recipients) || "undisclosed recipients"}</span>
            <IconChevronDown className={open ? "rotate-180" : ""} />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <ReplyActions message={message} />
          {props.menu}
        </div>
      </header>
      {open && (
        <div className="ps-11">
          <Details message={message} name={name} />
        </div>
      )}
    </div>
  );
}

const ISLAND_HIT = "before:min-w-0";

function HeaderAction(props: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  small?: boolean;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size={props.small ? "sq-2xs" : "sq-xs"}
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

function Recipient({ id, label }: { id: string; label: string }) {
  const copy = () =>
    navigator.clipboard.writeText(id).then(
      () => appToast.success("Address copied"),
      () => appToast.error("The address could not be copied."),
    );
  return (
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

/** A reply sent from here that has not come back as a message yet: a row, dimmed. */
export function PendingItem({ send }: { send: PendingSend }) {
  const failed = send.status === "failed";
  const label = failed
    ? `Not sent${send.error ? `: ${send.error}` : ""}`
    : send.status === "queued"
      ? "Queued"
      : "Sending…";
  return (
    <article aria-label="You, sending" className="border-b">
      <header className="flex items-baseline gap-3 px-5 pt-5 pb-3">
        <span className="flex-1 text-sm">You</span>
        <span
          className={`text-xs ${failed ? "text-danger-subtle-foreground" : "text-subtle-foreground"}`}
        >
          {label}
        </span>
      </header>
      <div className={`px-5 pb-5 ${failed ? "" : "opacity-70"}`}>
        <Body text={send.text} />
      </div>
    </article>
  );
}

function Body({ text }: { text: string }) {
  return (
    <p className="text-sm/6 break-words whitespace-pre-wrap">
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
