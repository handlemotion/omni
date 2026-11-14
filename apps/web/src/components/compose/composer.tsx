// The composer (fan-out item R2): an inline reply or forward under the conversation, and new
// mail on the compose page. Both share the frame below: recipients, the body with the
// signature, files, canned replies, a shared draft that saves as you type, Cmd/Ctrl+Enter to
// send, and the undo-send toast. No Figma frame exists yet; this is a proposal built from the
// primitives.
import type { NewMessageDraft } from "@/hooks/use-compose-pane.ts";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  useHandoff,
  useRenderCannedReply,
  useReplyFromMailboxes,
  useSendNew,
  useSignature,
  type CannedReply,
  type ComposerFile,
  type Draft,
} from "@/hooks/use-compose.ts";
import type { Message, Thread } from "@/lib/types.ts";
import { CannedPicker } from "./canned-picker.tsx";
import { AttachButton, ComposerFiles } from "./composer-files.tsx";
import { useComposerState, type ReplyKind } from "./composer-state.tsx";
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

/** Whom a reply starts addressed to, by kind: the latest sender, or everyone outside the team. */
function recipientsFor(kind: ReplyKind, thread: Thread, source: Message | undefined): string[] {
  return kind === "replyAll"
    ? customerRecipients(thread.messages, thread.mailboxAddress)
    : replyRecipients(source ?? thread.messages.at(-1));
}

/**
 * The email being written (a reply, or a forward picked from a message's menu), as the thread's
 * next message: a card at the end of the timeline, once Reply or Forward opens it. A shared
 * inbox's hidden notes have their own composer floating at the pane's bottom (`ChatDock`). Replies go from the inbox's address with your name; they
 * show in the thread at once and can be undone while they wait in the outbox. From one of your own
 * mailboxes instead, a reply hands the conversation off to you (ADR 0030).
 */
export function ReplyComposer({ thread, docked = false }: { thread: Thread; docked?: boolean }) {
  const state = useComposerState();
  const showing = state.email && state.mode === "public";
  const box = useRef<HTMLDivElement>(null);
  const key = `${thread.id}:${state.forwardId ? `forward:${state.forwardId}` : `reply:${state.replyToId ?? ""}`}:${state.generation}`;
  // In the thread, the email being written is its next message: brought into view where it opens.
  useLayoutEffect(() => {
    if (showing && !docked) box.current?.scrollIntoView({ block: "nearest" });
  }, [showing, docked, key]);
  // Kept mounted while Hidden shows after a send, so its undo can hand the text back.
  if (!state.email) return null;
  return (
    // Docked (the email view): floating 16px off the pane's bottom over a fade, like the notes.
    // In the conversation: your next message, under your name like the ones you sent.
    <div
      ref={box}
      hidden={!showing}
      className={docked ? "relative px-5 pb-4" : "flex flex-col items-end gap-3"}
    >
      {!docked && (
        <header className="flex items-center gap-2">
          <span className="text-sm">You</span>
        </header>
      )}
      {docked && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-b from-transparent to-background to-[2.5rem]"
        />
      )}
      {/* A fresh composer per reply or forwarded message: its own recipients, body and draft. */}
      <div className="relative w-full">
        <ModeComposer
          key={key}
          thread={thread}
          mode={state.forwardId ? "forward" : "reply"}
          sourceId={state.forwardId ?? state.replyToId}
        />
      </div>
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
  const latest = thread.messages.at(-1);
  const { signature, isLoading: signatureLoading } = useSignature(thread.mailboxId);
  // A reply can leave the shared inbox from one of your own mailboxes: a hand-off (ADR 0030).
  const fromOptions = useReplyFromMailboxes({
    id: thread.mailboxId,
    address: thread.mailboxAddress,
  });
  const [fromId, setFromId] = useState(thread.mailboxId);
  const handingOff = mode === "reply" && fromId !== thread.mailboxId;
  // Files are staged on the mailbox that sends them.
  const files = useComposerFiles(handingOff ? fromId : thread.mailboxId);
  const reply = useComposeReply();
  const forward = useForward();
  const handoff = useHandoff();
  const cancelSend = useCancelSend();
  const render = useRenderCannedReply(thread.id);

  const replied = thread.messages.find((m) => m.id === props.sourceId) ?? latest;
  const defaultTo = mode === "reply" ? recipientsFor(state.replyKind, thread, replied) : [];
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
      // Reply on a chosen message resumes only a draft answering that message.
      matchSource: mode === "forward" || !!props.sourceId,
    },
  );
  // Whether this composer is still on screen, for an undo that comes back after it was replaced.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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
    // Opened for an undone send whose own composer had gone: it comes back here, as a draft.
    const handed = state.takeHandBack();
    if (handed) {
      setText(handed.text);
      setTo(handed.to);
      setCc(handed.cc);
      setBcc(handed.bcc);
      if (handed.cc.length || handed.bcc.length) setShowCopies(true);
      files.reset(handed.files);
      touched.current = true;
      return draft.save({
        bodyText: handed.text,
        to: asDraftAddresses(handed.to),
        cc: asDraftAddresses(handed.cc),
        bcc: asDraftAddresses(handed.bcc),
      });
    }
    if (draft.draft) return load(draft.draft);
    setText(startingBody(signature));
    if (mode === "forward") files.reset(originalFiles(source));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once, when both have loaded
  }, [draft.isLoading, signatureLoading]);

  // Only what the agent changed is saved: opening Forward must not leave an empty draft behind.
  const touched = useRef(false);
  const edited = (next: Partial<{ text: string; to: string[]; cc: string[]; bcc: string[] }>) => {
    // A hand-off is your own mail, not the team's: it is not kept in the inbox's shared draft,
    // which would also resume as a reply from the inbox.
    if (!started.current || handingOff) return;
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
    !forward.isPending &&
    !handoff.isPending;

  const send = () => {
    if (!canSend) return;
    const before = { text, to, cc, bcc, files: files.files };
    const attachments = files.attachments;
    // Sent explicitly unless they are exactly whom the server would reply to on its own.
    const recipientsChanged =
      mode === "forward" ||
      to.join() !== replyRecipients(source).join() ||
      cc.length > 0 ||
      bcc.length > 0;
    const restore = () => {
      // Replaced by Reply on another message: a fresh composer takes it, unless an email is
      // being written there, which falls to the clipboard below.
      if (!alive.current && state.handBack({ mode, sourceId, ...before })) return;
      // Something new was written since: keep it, and hand back the stopped one on the clipboard.
      if (!alive.current || hasWords(current.current, signature)) {
        void navigator.clipboard?.writeText(before.text).catch(() => undefined);
        appToast.message("Send stopped", { description: "Its text is on your clipboard." });
        return;
      }
      state.showEmail();
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
    state.sentEmail();
    if (mode === "forward") {
      setTo([]);
      setCc([]);
      setBcc([]);
    }
    if (handingOff) {
      handoff.mutate(
        {
          threadId: thread.id,
          mailboxId: fromId,
          ...(source ? { messageId: source.id } : {}),
          to,
          cc,
          bcc,
          text,
          attachments,
        },
        // No pending bubble: the mail lands in your own mailbox's thread, not this one.
        { onSuccess: (queued) => sent(queued), onError: failed },
      );
    } else if (mode === "reply") {
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
    const recipients = recipientsFor(next, thread, source);
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
    <ComposerFrame onFiles={files.add}>
      <FromRow
        mailboxes={mode === "reply" ? fromOptions : fromOptions.slice(0, 1)}
        value={handingOff ? fromId : thread.mailboxId}
        onChange={(next) => {
          // A staged file belongs to the mailbox it was uploaded for; another can't send it.
          if (files.files.length) {
            for (const file of files.files) files.remove(file.id);
            appToast.message("Attachments removed", {
              description: "Attach them again to send from this address.",
            });
          }
          if (next !== thread.mailboxId) {
            touched.current = false;
            void draft.discard();
          }
          setFromId(next);
        }}
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
        // Opened by Reply: ready to write.
        autoFocus={mode === "reply"}
      />
      <ComposerFiles files={files.files} onRemove={files.remove} />
      <Toolbar
        start={
          <>
            <KindMenu kind={mode === "forward" ? "forward" : state.replyKind} onChange={switchTo} />
            <AttachButton onFiles={files.add} />
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
        isPending={forward.isPending || handoff.isPending}
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
      {/* Tertiary: an edge and no fill, so it reads as a choice, apart from the icon tools. */}
      <Button intent="outline" size="sm" className="px-2" aria-label={`${current.label}, change`}>
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
  /** A bordered, rounded card on the page (full-screen compose), not the pane itself. */
  island?: boolean;
  /** An undone send's content, to start from instead of an empty message. */
  restored?: NewMessageDraft | undefined;
  /**
   * Called once a send is queued. Without it the form clears for the next message; with it the
   * caller closes the composer, and an undo gets the content back through `onUndone`.
   */
  onSent?: () => void;
  /** Takes an undone send back; false when it can't, and the text goes to the clipboard. */
  onUndone?: (draft: NewMessageDraft) => boolean;
}) {
  const mailboxId =
    props.restored?.mailboxId || props.initial.mailboxId || props.mailboxes[0]?.id || "";
  return mailboxId ? <NewMessage key={mailboxId} mailboxId={mailboxId} {...props} /> : null;
}

function NewMessage(props: {
  mailboxId: string;
  mailboxes: { id: string; address: string }[];
  initial: { to?: string | undefined; subject?: string | undefined };
  island?: boolean | undefined;
  restored?: NewMessageDraft | undefined;
  onSent?: (() => void) | undefined;
  onUndone?: ((draft: NewMessageDraft) => boolean) | undefined;
}) {
  const restored = props.restored;
  const [mailboxId, setMailboxId] = useState(props.mailboxId);
  const { signature, isLoading: signatureLoading } = useSignature(mailboxId);
  const files = useComposerFiles(mailboxId);
  const resetFiles = files.reset;
  const sendNew = useSendNew();
  const cancelSend = useCancelSend();
  const [to, setTo] = useState<string[]>(
    restored?.to ?? (props.initial.to ? props.initial.to.split(/[,;\s]+/).filter(Boolean) : []),
  );
  const [cc, setCc] = useState<string[]>(restored?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(restored?.bcc ?? []);
  const [showCopies, setShowCopies] = useState(!!(restored?.cc.length || restored?.bcc.length));
  const [subject, setSubject] = useState(restored?.subject ?? props.initial.subject ?? "");
  const [text, setText] = useState(restored?.text ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (started.current || signatureLoading) return;
    started.current = true;
    setReady(true);
    // A handed-back draft already holds its signature and files.
    if (restored) return resetFiles(restored.files);
    setText(startingBody(signature));
  }, [signature, signatureLoading, restored, resetFiles]);

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
          const { onSent, onUndone } = props;
          if (onSent) {
            onSent();
            offerUndoSend(queued, async () => {
              const stopped = await cancelSend(queued.actionId);
              if (stopped && !onUndone?.({ mailboxId, ...before })) {
                // A new message is open in its place: keep it, and hand this one back as the
                // reply composer does.
                void navigator.clipboard?.writeText(before.text).catch(() => undefined);
                appToast.message("Send stopped", { description: "Its text is on your clipboard." });
              }
              return stopped;
            });
            return;
          }
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
    <ComposerFrame flat={!props.island} fill onFiles={files.add}>
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
      <div data-composer-head className="flex min-h-(--composer-row) items-center border-b px-3">
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
    <div
      data-composer-head
      className="flex min-h-(--composer-row) items-center gap-2.5 border-b px-3 py-1"
    >
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
          // Row height: 52px on the full-page composer, a more compact 48px on a reply under the
          // conversation.
          props.fill ? "[--composer-row:--spacing(13)]" : "[--composer-row:--spacing(12)]",
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
