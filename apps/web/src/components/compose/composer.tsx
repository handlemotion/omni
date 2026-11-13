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
  IconGlobe,
  IconLock,
  IconMail,
  IconReply,
  IconX,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { appToast } from "@/components/ui/toast";
import { Menu, MenuDescription, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
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
import { useComposerState, type ComposerMode } from "./composer-state.tsx";
import { RecipientField } from "./recipient-field.tsx";
import { Toolbar } from "./toolbar.tsx";
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

/**
 * The composer pinned under the open conversation. On a shared inbox a switch above it picks
 * who will see what you write: Public is an email to the customer (or a
 * forward, picked from a message's menu), Hidden is an internal note only the team sees. A
 * personal thread is always Public. Replies go from the inbox's address with your name; they
 * show in the thread at once and can be undone while they wait in the outbox.
 */
export function ReplyComposer({ thread }: { thread: Thread }) {
  const state = useComposerState();
  const hidden = state.mode === "hidden";
  return (
    <div className="flex flex-col gap-2">
      {state.chat && <Visibility />}
      {/* Kept mounted while Public shows, so a half-written note waits there. */}
      {state.chat && (
        <div hidden={!hidden}>
          <ChatComposer key={thread.id} thread={thread} active={hidden} />
        </div>
      )}
      {!hidden && (
        // A fresh composer per reply or forwarded message: its own recipients, body and draft.
        <ModeComposer
          key={`${thread.id}:${state.forwardId ?? "reply"}`}
          thread={thread}
          mode={state.forwardId ? "forward" : "reply"}
          sourceId={state.forwardId}
          onStopForward={state.stopForward}
        />
      )}
    </div>
  );
}

const VISIBILITY = {
  public: {
    icon: IconGlobe,
    label: "Public",
    short: "Email the customer",
  },
  hidden: {
    icon: IconLock,
    label: "Hidden",
    short: "Only your team sees it",
  },
} as const;

/**
 * Who sees what you write, and the menu that changes it: one switch above the composer, like a
 * breadcrumb, instead of tabs. Each mode's menu item says its consequence, so a hidden note
 * never reads as mail and a public reply never reads as a note.
 */
function Visibility() {
  const { mode, setMode } = useComposerState();
  const current = VISIBILITY[mode];
  return (
    // The switch on the left; what each mode means is in its menu.
    <div className="flex min-w-0 items-center justify-between gap-2 text-sm text-muted-foreground">
      <MenuTrigger>
        <Button
          intent="ghost"
          size="sm"
          aria-label={`Visibility: ${current.label}`}
          // Its icon on the same line as the card's Reply icon below: 13px in (12px padding and
          // the 1px border), 5px of margin plus the button's 8px inset.
          className="ms-[5px] px-2 text-foreground"
        >
          <current.icon />
          {current.label}
          <IconChevronDown className="text-muted-foreground" />
        </Button>
        <Menu
          placement="top start"
          selectionMode="single"
          selectedKeys={[mode]}
          onSelectionChange={(keys) => {
            const next = [...keys][0] as ComposerMode | undefined;
            if (next) setMode(next);
          }}
        >
          {(["public", "hidden"] as const).map((id) => {
            const option = VISIBILITY[id];
            return (
              <MenuItem key={id} id={id} textValue={option.label}>
                <option.icon data-slot="icon" />
                <MenuLabel>{option.label}</MenuLabel>
                <MenuDescription>{option.short}</MenuDescription>
              </MenuItem>
            );
          })}
        </Menu>
      </MenuTrigger>
    </div>
  );
}

function ModeComposer(props: {
  thread: Thread;
  mode: Mode;
  /** The message to forward; a reply answers the latest. */
  sourceId: string | undefined;
  onStopForward: () => void;
}) {
  const { thread, mode } = props;
  const latest = thread.messages.at(-1);
  const { signature, isLoading: signatureLoading } = useSignature(thread.mailboxId);
  const files = useComposerFiles(thread.mailboxId);
  const reply = useComposeReply();
  const forward = useForward();
  const cancelSend = useCancelSend();
  const render = useRenderCannedReply(thread.id);

  const defaultTo =
    mode === "reply" ? customerRecipients(thread.messages, thread.mailboxAddress) : [];
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
    <ComposerFrame onFiles={files.add}>
      {/* One row: what this is (reply or forward), whom to, and from where. */}
      <Recipients
        lead={
          mode === "forward" ? (
            <ForwardMark message={source} onStop={props.onStopForward} />
          ) : (
            <IconReply aria-label="Reply" className="size-3.5" />
          )
        }
        from={thread.mailboxAddress}
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
      />
      <ComposerFiles files={files.files} onRemove={files.remove} />
      <Toolbar
        start={
          <>
            <AttachButton onFiles={files.add} />
            <CannedPicker mailboxId={thread.mailboxId} onPick={(r) => void insertCanned(r)} />
          </>
        }
        canSend={canSend}
        isPending={forward.isPending}
        onSend={send}
      />
    </ComposerFrame>
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
    <ComposerFrame onFiles={files.add}>
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
      <div className="flex min-h-11 items-center border-b px-3">
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
        rows={10}
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
    <div className="flex min-h-11 items-center gap-2.5 border-b px-3 py-1">
      <span className="w-8 shrink-0 text-sm text-muted-foreground">From</span>
      {props.mailboxes.length > 1 ? (
        <MenuTrigger>
          {/* -8px: the address starts where the To field's text does, not at the button's edge. */}
          <Button intent="plain" size="sm" aria-label={`From ${address}`} className="-ms-2 min-w-0">
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
        <span className="min-w-0 truncate text-sm">{address}</span>
      )}
    </div>
  );
}

/** The card around a composer. Dropping files anywhere on it attaches them. */
function ComposerFrame(props: { onFiles: (files: File[]) => void; children: ReactNode }) {
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
          "flex flex-col rounded-xl border bg-background shadow-raised outline-hidden",
          isDropTarget ? "border-ring" : "",
        ].join(" ")
      }
    >
      {props.children}
    </DropZone>
  );
}

function Recipients(props: {
  lead?: ReactNode;
  /** The sending address, at the end of the To line. */
  from?: string | undefined;
  to: string[];
  cc: string[];
  bcc: string[];
  showCopies: boolean;
  onShowCopies: () => void;
  autoFocus?: boolean;
  onChange: (next: Partial<{ to: string[]; cc: string[]; bcc: string[] }>) => void;
}) {
  return (
    <div className="flex flex-col">
      <RecipientField
        label="To"
        value={props.to}
        autoFocus={props.autoFocus}
        lead={props.lead}
        onChange={(to) => props.onChange({ to })}
        end={
          <span className="flex max-w-1/2 min-w-0 items-center gap-2">
            {props.from && (
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                From {props.from}
              </span>
            )}
            {!props.showCopies && (
              // -8px: the button's own padding; its ink ends 12px in, like the row's start.
              <Button
                intent="plain"
                size="sm"
                className="-me-2 shrink-0"
                onPress={props.onShowCopies}
              >
                Cc Bcc
              </Button>
            )}
          </span>
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
}) {
  return (
    <Textarea
      ref={props.ref}
      plain
      readOnly={props.readOnly}
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
      // Write's first line sits as far under the divider as the chips sit over it (measured).
      className="max-h-[min(24rem,30vh)] min-h-24 resize-none px-3 pt-0.5 pb-1 sm:px-3 sm:pt-0.5 sm:pb-1"
    />
  );
}

/**
 * A forward's mark in the To line's label column: the forward arrow, which turns into an X on
 * hover or focus, back to replying. Its tooltip says whose message goes.
 */
function ForwardMark({ message, onStop }: { message: Message | undefined; onStop: () => void }) {
  const from = !message
    ? "a"
    : message.fromMe
      ? "your"
      : `${message.fromName || message.fromAddress}'s`;
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-xs"
        aria-label={`Forward ${from} message. Reply instead`}
        // -5px each side: the 14px glyph sits 5px inside the 24px button; this puts it where
        // Reply's sits, with the chips as close after it.
        className="group -mx-[5px] text-muted-foreground hover:text-foreground"
        onPress={onStop}
      >
        <IconForward className="group-hover:hidden group-focus-visible:hidden" />
        <IconX className="hidden group-hover:block group-focus-visible:block" />
      </Button>
      <Tooltip>{`Forward ${from} message · Reply instead`}</Tooltip>
    </TooltipTrigger>
  );
}
