// The composer (fan-out item R2): an inline reply or forward under the conversation, and new
// mail on the compose page. Both share the frame below: recipients, the body with the
// signature, files, canned replies, a shared draft that saves as you type, Cmd/Ctrl+Enter to
// send, and the undo-send toast. No Figma frame exists yet; this is a proposal built from the
// primitives.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DropZone } from "react-aria-components/DropZone";
import {
  IconChevronDown,
  IconForward,
  IconMail,
  IconReply,
  IconReplyAll,
  IconTrash,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { appToast } from "@/components/ui/toast";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import {
  useCancelSend,
  useComposeReply,
  useComposerFiles,
  useDraft,
  useForward,
  useRenderCannedReply,
  useSendNew,
  useSignature,
  type CannedReply,
  type ComposerFile,
  type Draft,
} from "@/hooks/use-compose.ts";
import type { Message, Thread } from "@/lib/types.ts";
import { CannedPicker } from "./canned-picker.tsx";
import { AttachButton, ComposerFiles } from "./composer-files.tsx";
import { ChatComposer } from "./chat-composer.tsx";
import { useComposerState, type ReplyKind } from "./composer-state.tsx";
import { RecipientField } from "./recipient-field.tsx";
import { Toolbar } from "./toolbar.tsx";
import { Visibility } from "./visibility.tsx";
import { offerUndoSend } from "./undo-send.ts";

/** The RFC 3676 signature separator, so mail clients can fold it. */
const SIG_SEPARATOR = "-- \n";

/** A fresh body: two empty lines to write in, then the signature. */
const startingBody = (signature: string | null) =>
  signature ? `\n\n${SIG_SEPARATOR}${signature}` : "";

/** True when the body has words of its own, not only the signature. */
function hasWords(text: string, signature: string | null) {
  const own = signature ? text.replace(`${SIG_SEPARATOR}${signature}`, "") : text;
  return own.trim().length > 0;
}

const asDraftAddresses = (list: string[]) => list.map((address) => ({ name: null, address }));
type DraftFile = { uploadId: string } | { attachmentId: string };
const draftFiles = (files: ComposerFile[]): DraftFile[] =>
  files.flatMap((f): DraftFile[] =>
    f.attachment?.kind === "upload"
      ? [{ uploadId: f.attachment.uploadId }]
      : f.attachment?.kind === "attachment"
        ? [{ attachmentId: f.attachment.attachmentId }]
        : [],
  );

/** Files a saved draft carries, named from the thread where they came from an original. */
function filesFromDraft(draft: Draft, messages: Message[] = []): ComposerFile[] {
  const originals = messages.flatMap((m) => m.attachments);
  return draft.attachments.map((a) => {
    if ("attachmentId" in a && a.attachmentId) {
      const original = originals.find((o) => o.id === a.attachmentId);
      return {
        id: a.attachmentId,
        filename: original?.filename ?? "Attachment",
        size: original?.size ?? 0,
        mimeType: original?.mimeType ?? "",
        status: "ready" as const,
        progress: 1,
        attachment: { kind: "attachment" as const, attachmentId: a.attachmentId },
      };
    }
    const uploadId = "uploadId" in a ? (a.uploadId ?? "") : "";
    return {
      id: uploadId,
      filename: "Attached file",
      size: 0,
      mimeType: "",
      status: "ready" as const,
      progress: 1,
      attachment: { kind: "upload" as const, uploadId },
    };
  });
}

/** The original's own files (not inline images), for a forward to carry. */
function originalFiles(message: Message | undefined): ComposerFile[] {
  return (message?.attachments ?? [])
    .filter((a) => !a.inline)
    .map((a) => ({
      id: a.id,
      filename: a.filename ?? "Attachment",
      size: a.size,
      mimeType: a.mimeType ?? "",
      status: "ready" as const,
      progress: 1,
      attachment: { kind: "attachment" as const, attachmentId: a.id },
    }));
}

/** Who the server replies to by default: the sender, or for our (or a teammate's) last message, whoever we wrote to. */
function replyRecipients(message: Message | undefined): string[] {
  if (!message) return [];
  return message.fromTeam ? message.to.map((a) => a.address) : [message.fromAddress];
}

/**
 * Who a reply starts addressed to: everyone outside the team on the thread (each sender, and
 * whoever was in To or Cc), the latest sender first. Teammates add more by hand.
 */
function customerRecipients(messages: Message[], inbox: string): string[] {
  const ours = new Set([inbox.toLowerCase()]);
  for (const m of messages) if (m.fromTeam) ours.add(m.fromAddress.toLowerCase());
  const seen = new Map<string, string>();
  const add = (address: string) => {
    const key = address.toLowerCase();
    if (!ours.has(key) && !seen.has(key)) seen.set(key, address);
  };
  for (const m of messages.toReversed()) {
    if (!m.fromTeam) add(m.fromAddress);
    for (const a of [...m.to, ...m.cc]) add(a.address);
  }
  return [...seen.values()];
}

type Mode = "reply" | "forward";

/** Whom a reply starts addressed to, by kind: the latest sender, or everyone outside the team. */
function recipientsFor(kind: ReplyKind, thread: Thread): string[] {
  return kind === "replyAll"
    ? customerRecipients(thread.messages, thread.mailboxAddress)
    : replyRecipients(thread.messages.at(-1));
}

/**
 * The composer pinned under the open conversation. On a shared inbox a switch among its tools
 * picks who will see what you write: Public is an email to the customer (or a
 * forward, picked from a message's menu), Hidden is an internal note only the team sees. A
 * personal thread is always Public, and shows the composer only once Reply or Forward opens it. Replies go from the inbox's address with your name; they
 * show in the thread at once and can be undone while they wait in the outbox.
 */
export function ReplyComposer({ thread }: { thread: Thread }) {
  const state = useComposerState();
  const hidden = state.mode === "hidden";
  if (!state.open) return null;
  return (
    // The pane's bottom edge, full width: one composer whose mode switches in place. A hidden
    // note's edge is dashed, like the notes it adds.
    <div
      className={`flex flex-col border-t ${hidden ? "border-dashed border-muted-foreground/60" : ""}`}
    >
      {/* Kept mounted while Public shows, so a half-written note waits there. */}
      {state.chat && (
        <div hidden={!hidden}>
          <ChatComposer key={thread.id} thread={thread} active={hidden} />
        </div>
      )}
      {!hidden && (
        // A fresh composer per reply or forwarded message: its own recipients, body and draft.
        <ModeComposer
          key={`${thread.id}:${state.forwardId ?? "reply"}:${state.generation}`}
          thread={thread}
          mode={state.forwardId ? "forward" : "reply"}
          sourceId={state.forwardId}
        />
      )}
    </div>
  );
}

function ModeComposer(props: {
  thread: Thread;
  mode: Mode;
  /** The message to forward; a reply answers the latest. */
  sourceId: string | undefined;
}) {
  const { thread, mode } = props;
  const state = useComposerState();
  const { chat } = state;
  const latest = thread.messages.at(-1);
  const { signature, isLoading: signatureLoading } = useSignature(thread.mailboxId);
  const files = useComposerFiles(thread.mailboxId);
  const reply = useComposeReply();
  const forward = useForward();
  const cancelSend = useCancelSend();
  const render = useRenderCannedReply(thread.id);

  const defaultTo = mode === "reply" ? recipientsFor(state.replyKind, thread) : [];
  const [to, setTo] = useState<string[]>(defaultTo);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [showCopies, setShowCopies] = useState(false);
  // The message replied to or forwarded: the latest, or the one a resumed draft was written for.
  const [sourceId, setSourceId] = useState(props.sourceId ?? latest?.id);
  const source = thread.messages.find((m) => m.id === sourceId) ?? latest;
  // Read only until the draft and signature are in, so they can't replace what was typed.
  const [ready, setReady] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // What the composer holds now, for an undo that comes back later.
  const current = useRef(text);
  current.current = text;

  const draft = useDraft(
    {
      mailboxId: thread.mailboxId,
      kind: mode,
      threadId: thread.id,
      ...(sourceId ? { sourceMessageId: sourceId } : {}),
    },
    {
      onConflict: (theirs) => {
        load(theirs);
        appToast.message("A teammate changed this draft. You're now editing their version.");
      },
    },
  );

  // Start from the shared draft when there is one, else from the signature (and, for a forward,
  // the original's files). Once: typing must never be replaced by a refetch.
  const started = useRef(false);
  const load = (saved: Draft) => {
    setText(saved.bodyText);
    if (saved.sourceMessageId) setSourceId(saved.sourceMessageId);
    if (saved.to.length) setTo(saved.to.map((a) => a.address));
    setCc(saved.cc.map((a) => a.address));
    setBcc(saved.bcc.map((a) => a.address));
    if (saved.cc.length || saved.bcc.length) setShowCopies(true);
    files.reset(filesFromDraft(saved, thread.messages));
  };
  useEffect(() => {
    if (started.current || draft.isLoading || signatureLoading) return;
    started.current = true;
    setReady(true);
    if (draft.draft) return load(draft.draft);
    setText(startingBody(signature));
    if (mode === "forward") files.reset(originalFiles(source));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once, when both have loaded
  }, [draft.isLoading, signatureLoading]);

  // Only what the agent changed is saved: opening Forward must not leave an empty draft behind.
  const touched = useRef(false);
  const edited = (next: Partial<{ text: string; to: string[]; cc: string[]; bcc: string[] }>) => {
    if (!started.current) return;
    touched.current = true;
    draft.save({
      bodyText: next.text ?? text,
      // A reply left to its default recipients saves none, so it follows the conversation.
      to: asDraftAddresses(next.to ?? to),
      cc: asDraftAddresses(next.cc ?? cc),
      bcc: asDraftAddresses(next.bcc ?? bcc),
      attachments: draftFiles(files.files),
    });
  };
  // Files change outside the handlers above (uploads finish later): save when they settle.
  const fileIds = draftFiles(files.files)
    .map((f) => ("uploadId" in f ? f.uploadId : f.attachmentId))
    .join();
  useEffect(() => {
    if (touched.current && !files.busy) edited({});
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- saves on file changes only
  }, [fileIds, files.busy]);

  const canSend =
    !files.busy &&
    to.length > 0 &&
    (mode === "forward" || hasWords(text, signature)) &&
    // Replies queue (offline they wait their turn, each as a pending bubble), so another can be
    // written and sent while one is in flight; the box clears on send, so nothing goes twice.
    !forward.isPending;

  const send = () => {
    if (!canSend) return;
    const before = { text, to, cc, bcc, files: files.files };
    const attachments = files.attachments;
    // Sent explicitly unless they are exactly whom the server would reply to on its own.
    const recipientsChanged =
      mode === "forward" ||
      to.join() !== replyRecipients(latest).join() ||
      cc.length > 0 ||
      bcc.length > 0;
    const restore = () => {
      // Something new was written since: keep it, and hand back the stopped one on the clipboard.
      if (hasWords(current.current, signature)) {
        void navigator.clipboard?.writeText(before.text).catch(() => undefined);
        appToast.message("Send stopped", { description: "Its text is on your clipboard." });
        return;
      }
      setText(before.text);
      setTo(before.to);
      setCc(before.cc);
      setBcc(before.bcc);
      files.reset(before.files);
      textarea.current?.focus();
      // The send deleted the draft; what came back is a draft again.
      edited({ text: before.text, to: before.to, cc: before.cc, bcc: before.bcc });
    };
    const handedOver = draft.detach();
    const sent = (queued: Parameters<typeof offerUndoSend>[0], pending?: { key: string }) => {
      void handedOver.then(draft.remove);
      offerUndoSend(queued, async () => {
        const stopped = await cancelSend(
          queued.actionId,
          pending ? { threadId: thread.id, key: pending.key } : undefined,
        );
        if (stopped) restore();
        return stopped;
      });
    };
    const failed = (error: Error) => {
      appToast.error(error.message);
      restore();
    };

    // Clear at once, like a chat: the reply shows in the thread as a pending send.
    touched.current = false;
    setText(startingBody(signature));
    files.reset();
    if (mode === "forward") {
      setTo([]);
      setCc([]);
      setBcc([]);
    }
    if (mode === "reply") {
      reply.mutate(
        {
          threadId: thread.id,
          text,
          ...(source ? { messageId: source.id } : {}),
          ...(recipientsChanged ? { to, cc, bcc } : {}),
          attachments,
        },
        {
          onSuccess: (queued, variables) => sent(queued, variables),
          // A failed reply stays in the thread as a failed pending send with its text.
          onError: (error) => appToast.error(error.message),
        },
      );
    } else {
      forward.mutate(
        {
          threadId: thread.id,
          ...(source ? { messageId: source.id } : {}),
          to,
          cc,
          bcc,
          text,
          includeAttachments: false,
          attachments,
        },
        // Stays in Forward until it settles: the callbacks only run while this is mounted.
        { onSuccess: (queued) => sent(queued), onError: failed },
      );
    }
  };

  // Reply and Reply all keep what was written and swap the recipients; Forward is its own draft.
  const switchTo = (next: ReplyKind | "forward") => {
    if (next === "forward") return state.forward(source?.id ?? latest?.id ?? "");
    state.openReply(next);
    if (mode === "forward") return;
    const recipients = recipientsFor(next, thread);
    setTo(recipients);
    edited({ to: recipients });
  };

  // Throws the draft and its uploads away and closes the composer.
  const discard = () => {
    touched.current = false;
    void draft.detach().then(draft.remove);
    for (const file of files.files) files.remove(file.id);
    state.close();
  };

  const insertCanned = async (picked: CannedReply) => {
    try {
      const rendered = await render(picked.id);
      const el = textarea.current;
      const at = el ? el.selectionStart : 0;
      const end = el ? el.selectionEnd : 0;
      // Into the empty lines above the signature when the caret is still at the start.
      const next = text.slice(0, at) + rendered.text + text.slice(end);
      setText(next);
      edited({ text: next });
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(at + rendered.text.length, at + rendered.text.length);
      });
      if (rendered.missing.length) {
        appToast.warning("Some details are missing", {
          description: `Fill in ${rendered.missing.join(", ")} before sending.`,
        });
      }
    } catch (error) {
      appToast.error((error as Error).message);
    }
  };

  return (
    <ComposerFrame flat onFiles={files.add}>
      <FromRow
        mailboxes={[{ id: thread.mailboxId, address: thread.mailboxAddress }]}
        value={thread.mailboxId}
        onChange={() => undefined}
      />
      <Recipients
        to={to}
        cc={cc}
        bcc={bcc}
        showCopies={showCopies}
        onShowCopies={() => setShowCopies(true)}
        autoFocus={mode === "forward"}
        onChange={(next) => {
          if (next.to) setTo(next.to);
          if (next.cc) setCc(next.cc);
          if (next.bcc) setBcc(next.bcc);
          edited(next);
        }}
      />
      <Body
        ref={textarea}
        label={mode === "reply" ? "Reply" : "Message"}
        readOnly={!ready}
        value={text}
        onChange={(next) => {
          setText(next);
          edited({ text: next });
        }}
        onSend={send}
        // Opened by Reply on a personal thread: ready to write. A shared inbox's stays put.
        autoFocus={!chat && mode === "reply"}
      />
      <ComposerFiles files={files.files} onRemove={files.remove} />
      <Toolbar
        start={
          <>
            <KindMenu kind={mode === "forward" ? "forward" : state.replyKind} onChange={switchTo} />
            <AttachButton onFiles={files.add} />
            {chat && <Visibility />}
            <CannedPicker mailboxId={thread.mailboxId} onPick={(r) => void insertCanned(r)} />
          </>
        }
        end={
          <TooltipTrigger delay={400}>
            <Button
              intent="ghost"
              size="sq-sm"
              aria-label="Discard"
              className="text-muted-foreground hover:text-foreground"
              onPress={discard}
            >
              <IconTrash />
            </Button>
            <Tooltip>Discard</Tooltip>
          </TooltipTrigger>
        }
        canSend={canSend}
        isPending={forward.isPending}
        onSend={send}
      />
    </ComposerFrame>
  );
}

const KINDS = {
  reply: { icon: IconReply, label: "Reply" },
  replyAll: { icon: IconReplyAll, label: "Reply all" },
  forward: { icon: IconForward, label: "Forward" },
} as const;
type Kind = keyof typeof KINDS;

/** What the composer sends, and the menu that changes it: Reply, Reply all or Forward. */
function KindMenu({ kind, onChange }: { kind: Kind; onChange: (next: Kind) => void }) {
  const current = KINDS[kind];
  return (
    <MenuTrigger>
      <Button intent="ghost" size="sm" aria-label={`${current.label}, change`}>
        <current.icon />
        {current.label}
        <IconChevronDown />
      </Button>
      <Menu
        placement="top start"
        selectionMode="single"
        selectedKeys={[kind]}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as Kind | undefined;
          if (next && next !== kind) onChange(next);
        }}
      >
        {(Object.keys(KINDS) as Kind[]).map((id) => {
          const option = KINDS[id];
          return (
            <MenuItem key={id} id={id} textValue={option.label}>
              <option.icon data-slot="icon" />
              <MenuLabel>{option.label}</MenuLabel>
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

/**
 * New mail from one of your mailboxes. `initial` prefills it (deep links: `?to=&subject=`).
 * Sent mail has no thread until the mail service files it, so the form clears and the toast
 * offers undo.
 */
export function NewMessageComposer(props: {
  mailboxes: { id: string; address: string }[];
  initial: {
    mailboxId?: string | undefined;
    to?: string | undefined;
    subject?: string | undefined;
  };
}) {
  const mailboxId = props.initial.mailboxId || props.mailboxes[0]?.id || "";
  return mailboxId ? <NewMessage key={mailboxId} mailboxId={mailboxId} {...props} /> : null;
}

function NewMessage(props: {
  mailboxId: string;
  mailboxes: { id: string; address: string }[];
  initial: { to?: string | undefined; subject?: string | undefined };
}) {
  const [mailboxId, setMailboxId] = useState(props.mailboxId);
  const { signature, isLoading: signatureLoading } = useSignature(mailboxId);
  const files = useComposerFiles(mailboxId);
  const sendNew = useSendNew();
  const cancelSend = useCancelSend();
  const [to, setTo] = useState<string[]>(
    props.initial.to ? props.initial.to.split(/[,;\s]+/).filter(Boolean) : [],
  );
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState(props.initial.subject ?? "");
  const [text, setText] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (started.current || signatureLoading) return;
    started.current = true;
    setReady(true);
    setText(startingBody(signature));
  }, [signature, signatureLoading]);

  const canSend = !files.busy && to.length > 0 && !sendNew.isPending;
  const send = () => {
    if (!canSend) return;
    const before = { to, cc, bcc, subject, text, files: files.files };
    const restore = () => {
      setTo(before.to);
      setCc(before.cc);
      setBcc(before.bcc);
      setSubject(before.subject);
      setText(before.text);
      files.reset(before.files);
    };
    sendNew.mutate(
      { mailboxId, to, cc, bcc, subject, text, attachments: files.attachments },
      {
        onSuccess: (queued) => {
          setTo([]);
          setCc([]);
          setBcc([]);
          setSubject("");
          setText(startingBody(signature));
          files.reset();
          offerUndoSend(queued, async () => {
            const stopped = await cancelSend(queued.actionId);
            if (stopped) restore();
            return stopped;
          });
        },
        onError: (error) => appToast.error(error.message),
      },
    );
  };

  return (
    <ComposerFrame flat fill onFiles={files.add}>
      <FromRow
        mailboxes={props.mailboxes}
        value={mailboxId}
        onChange={(next) => {
          // A staged file belongs to the mailbox it was uploaded for; another can't send it.
          if (files.files.length) {
            for (const file of files.files) files.remove(file.id);
            appToast.message("Attachments removed", {
              description: "Attach them again to send from this address.",
            });
          }
          setMailboxId(next);
        }}
      />
      <Recipients
        to={to}
        cc={cc}
        bcc={bcc}
        showCopies={showCopies}
        onShowCopies={() => setShowCopies(true)}
        autoFocus
        onChange={(next) => {
          if (next.to) setTo(next.to);
          if (next.cc) setCc(next.cc);
          if (next.bcc) setBcc(next.bcc);
        }}
      />
      <div data-composer-head className="flex min-h-11 items-center border-b px-3">
        <Input
          plain
          size="sm"
          aria-label="Subject"
          placeholder="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </div>
      <Body
        ref={textarea}
        label="Message"
        readOnly={!ready}
        value={text}
        onChange={setText}
        onSend={send}
        fill
      />
      <ComposerFiles files={files.files} onRemove={files.remove} />
      <Toolbar
        start={<AttachButton onFiles={files.add} />}
        canSend={canSend}
        isPending={sendNew.isPending}
        onSend={send}
      />
    </ComposerFrame>
  );
}

/** New mail's From row, laid out like To: the address, and a menu to switch it when there are more. */
function FromRow(props: {
  mailboxes: { id: string; address: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const address = props.mailboxes.find((m) => m.id === props.value)?.address;
  return (
    <div data-composer-head className="flex min-h-11 items-center gap-2.5 border-b px-3 py-1">
      <span className="w-8 shrink-0 text-sm text-muted-foreground">From</span>
      {props.mailboxes.length > 1 ? (
        <MenuTrigger>
          {/* Grey on hover, like the composer's other menus. -2px: the button's 10px padding
              puts the address 8px in, where the To pills' text starts. */}
          <Button
            intent="ghost"
            size="sm"
            aria-label={`From ${address}`}
            className="-ms-0.5 min-w-0"
          >
            <span className="truncate">{address}</span>
            <IconChevronDown className="text-muted-foreground" />
          </Button>
          <Menu
            placement="bottom start"
            selectionMode="single"
            selectedKeys={[props.value]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (typeof next === "string") props.onChange(next);
            }}
          >
            {props.mailboxes.map((m) => (
              <MenuItem key={m.id} id={m.id} textValue={m.address}>
                <IconMail data-slot="icon" />
                <MenuLabel>{m.address}</MenuLabel>
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : (
        // 8px in: the To pills' text starts there, inside their fill.
        <span className="min-w-0 truncate ps-2 text-sm">{address}</span>
      )}
    </div>
  );
}

/**
 * What a composer sits in. Dropping files anywhere on it attaches them. `flat`: part of the
 * pane, not a card in it (new mail, replies); `fill`: it takes the pane's spare height (new mail).
 */
function ComposerFrame(props: {
  onFiles: (files: File[]) => void;
  flat?: boolean | undefined;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <DropZone
      aria-label="Drop files to attach"
      getDropOperation={(types) => (types.has("text/plain") ? "cancel" : "copy")}
      onDrop={async (event) => {
        const dropped = await Promise.all(
          event.items.flatMap((item) => (item.kind === "file" ? [item.getFile()] : [])),
        );
        if (dropped.length) props.onFiles(dropped);
      }}
      className={({ isDropTarget }) =>
        [
          // White, unpadded: each row keeps its own 12px sides, so dividers run the full width.
          "flex flex-col bg-background outline-hidden",
          props.flat ? "" : "rounded-xl border shadow-raised",
          props.fill ? "min-h-0 flex-1" : "",
          // Flat there is no border to light up, so a drop rings its inside edge.
          isDropTarget ? (props.flat ? "ring-1 ring-ring ring-inset" : "border-ring") : "",
        ].join(" ")
      }
    >
      {/* A press anywhere below the header that isn't on a control writes: it focuses the body,
          not only a press on its text. */}
      <div className="contents" onMouseDown={focusBody} onClick={focusBody}>
        {props.children}
      </div>
    </DropZone>
  );
}

const CONTROLS =
  "button, a, input, textarea, select, [role=button], [role=combobox], [role=option], [data-composer-head]";

function focusBody(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0 || (event.target as HTMLElement).closest(CONTROLS)) return;
  const body = event.currentTarget.querySelector<HTMLTextAreaElement>("[data-composer-body]");
  if (!body || body.readOnly) return;
  // The mouse press would move focus away, and the drop zone around it would focus its own
  // hidden button on click: neither gets the event. Then the caret goes at the end.
  event.stopPropagation();
  event.preventDefault();
  body.focus();
  body.setSelectionRange(body.value.length, body.value.length);
}

function Recipients(props: {
  to: string[];
  cc: string[];
  bcc: string[];
  showCopies: boolean;
  onShowCopies: () => void;
  autoFocus?: boolean;
  onChange: (next: Partial<{ to: string[]; cc: string[]; bcc: string[] }>) => void;
}) {
  return (
    <div data-composer-head className="flex flex-col">
      <RecipientField
        label="To"
        value={props.to}
        autoFocus={props.autoFocus}
        onChange={(to) => props.onChange({ to })}
        end={
          !props.showCopies && (
            // -8px: the button's own padding; its ink ends 12px in, like the row's start.
            <Button
              intent="plain"
              size="sm"
              className="-me-2 shrink-0"
              onPress={props.onShowCopies}
            >
              Cc Bcc
            </Button>
          )
        }
      />
      {props.showCopies && (
        <>
          <RecipientField label="Cc" value={props.cc} onChange={(cc) => props.onChange({ cc })} />
          <RecipientField
            label="Bcc"
            value={props.bcc}
            onChange={(bcc) => props.onChange({ bcc })}
          />
        </>
      )}
    </div>
  );
}

function Body(props: {
  ref: React.Ref<HTMLTextAreaElement>;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  rows?: number;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** Take the frame's spare height, so the tools sit at its bottom and writing room stays long. */
  fill?: boolean;
}) {
  return (
    <Textarea
      ref={props.ref}
      plain
      readOnly={props.readOnly}
      autoFocus={props.autoFocus}
      aria-label={props.label}
      placeholder="Write…"
      rows={props.rows ?? 4}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          props.onSend();
        }
      }}
      data-composer-body
      // 12px under the divider, the same as its 12px sides, so Write doesn't crowd the line.
      className={`${props.fill ? "min-h-24 flex-1" : "max-h-[min(24rem,30vh)] min-h-24"} resize-none px-3 pt-3 pb-1 sm:px-3 sm:pt-3 sm:pb-1`}
    />
  );
}
