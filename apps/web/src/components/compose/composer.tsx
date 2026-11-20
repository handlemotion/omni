import type { NewMessageDraft } from "@/hooks/use-compose-pane.ts";
import { useYourMailboxes } from "@/hooks/use-mailbox-identity.ts";
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
import { Menu, MenuDescription, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
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

const SIG_SEPARATOR = "-- \n";

const startingBody = (signature: string | null) =>
  signature ? `\n\n${SIG_SEPARATOR}${signature}` : "";

function hasWords(text: string, signature: string | null) {
  const own = signature ? text.replace(`${SIG_SEPARATOR}${signature}`, "") : text;
  return own.trim().length > 0;
}

const asDraftAddresses = (list: string[]) => list.map((address) => ({ name: null, address }));
type DraftFile = { uploadId: string } | { attachmentId: string };
const draftFiles = (files: ComposerFile[]) =>
  files.flatMap((f) => {
    const result: DraftFile[] =
      f.attachment?.kind === "upload"
        ? [{ uploadId: f.attachment.uploadId }]
        : f.attachment?.kind === "attachment"
          ? [{ attachmentId: f.attachment.attachmentId }]
          : [];
    return result;
  }) satisfies DraftFile[];

/** Files a saved draft carries, named from the thread where they came from an original. */
export const filesFromDraft: (draft: Draft, messages?: Message[]) => ComposerFile[] = (
  draft,
  messages = [],
) => {
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
};

const originalFiles: (message: Message | undefined) => ComposerFile[] = (message) => {
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
};

const replyRecipients: (message: Message | undefined) => string[] = (message) => {
  if (!message) return [];
  return message.fromTeam ? message.to.map((a) => a.address) : [message.fromAddress];
};

function customerRecipients(messages: Message[], inbox: string) {
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
  return [...seen.values()] satisfies string[];
}

type Mode = "reply" | "forward";

function recipientsFor(kind: ReplyKind, thread: Thread, source: Message | undefined) {
  return (
    kind === "replyAll"
      ? customerRecipients(thread.messages, thread.mailboxAddress)
      : replyRecipients(source ?? thread.messages.at(-1))
  ) satisfies string[];
}

/**
 * The email being written (a reply, or a forward picked from a message's menu), docked at the
 * bottom of the conversation once Reply or Forward opens it. A shared inbox's hidden notes have
 * their own composer floating at the pane's bottom (`ChatDock`). Replies go from the inbox's
 * address with your name; they show in the thread at once and can be undone while they wait in
 * the outbox. From one of your own mailboxes instead, a reply hands the conversation off to you.
 */
export function ReplyComposer({ thread }: { thread: Thread }) {
  const state = useComposerState();
  const showing = state.email && state.mode === "public";
  const key = `${thread.id}:${state.forwardId ? `forward:${state.forwardId}` : `reply:${state.replyToId ?? ""}`}:${state.generation}`;
  if (!state.email) return null;
  return (
    <div hidden={!showing} className="relative px-5 pb-4">
      <ModeComposer
        key={key}
        thread={thread}
        mode={state.forwardId ? "forward" : "reply"}
        sourceId={state.forwardId ?? state.replyToId}
      />
    </div>
  );
}

function ModeComposer(props: { thread: Thread; mode: Mode; sourceId: string | undefined }) {
  const { thread, mode } = props;
  const state = useComposerState();
  const latest = thread.messages.at(-1);
  const { signature, isLoading: signatureLoading } = useSignature(thread.mailboxId);
  const fromOptions = useReplyFromMailboxes({
    id: thread.mailboxId,
    address: thread.mailboxAddress,
  });
  const [fromId, setFromId] = useState(thread.mailboxId);
  const handingOff = mode === "reply" && fromId !== thread.mailboxId;
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
  const [sourceId, setSourceId] = useState(props.sourceId ?? latest?.id);
  const source = thread.messages.find((m) => m.id === sourceId) ?? latest;
  const [ready, setReady] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
      matchSource: mode === "forward" || !!props.sourceId,
    },
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

  const touched = useRef(false);
  const edited = (next: Partial<{ text: string; to: string[]; cc: string[]; bcc: string[] }>) => {
    if (!started.current || handingOff) return;
    touched.current = true;
    draft.save({
      bodyText: next.text ?? text,
      to: asDraftAddresses(next.to ?? to),
      cc: asDraftAddresses(next.cc ?? cc),
      bcc: asDraftAddresses(next.bcc ?? bcc),
      attachments: draftFiles(files.files),
    });
  };
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
    !forward.isPending &&
    !handoff.isPending;

  const send = () => {
    if (!canSend) return;
    const before = { text, to, cc, bcc, files: files.files };
    const attachments = files.attachments;
    const recipientsChanged =
      mode === "forward" ||
      to.join() !== replyRecipients(source).join() ||
      cc.length > 0 ||
      bcc.length > 0;
    const restore = () => {
      if (!alive.current && state.handBack({ mode, sourceId, ...before })) return;
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
      handoff.mutateDetached(
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
        { onSuccess: (queued) => sent(queued), onError: failed },
      );
    } else if (mode === "reply") {
      reply.mutateDetached(
        {
          threadId: thread.id,
          text,
          ...(source ? { messageId: source.id } : {}),
          ...(recipientsChanged ? { to, cc, bcc } : {}),
          attachments,
        },
        {
          onSuccess: (queued, variables) => sent(queued, variables),
          onError: (error) => appToast.error(error.message),
        },
      );
    } else {
      forward.mutateDetached(
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
        { onSuccess: (queued) => sent(queued), onError: failed },
      );
    }
  };

  const switchTo = (next: ReplyKind | "forward") => {
    if (next === "forward") return state.forward(source?.id ?? latest?.id ?? "");
    state.openReply(next);
    if (mode === "forward") return;
    const recipients = recipientsFor(next, thread, source);
    setTo(recipients);
    edited({ to: recipients });
  };

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

function KindMenu({ kind, onChange }: { kind: Kind; onChange: (next: Kind) => void }) {
  const current = KINDS[kind];
  return (
    <MenuTrigger>
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

function FromRow(props: {
  mailboxes: { id: string; address: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const yours = useYourMailboxes();
  const labelOf = (id: string) => yours.find((box) => box.id === id)?.label;
  const address = props.mailboxes.find((m) => m.id === props.value)?.address;
  return (
    <div
      data-composer-head
      className="flex min-h-(--composer-row) items-center gap-2.5 border-b px-3 py-1"
    >
      <span className="w-8 shrink-0 text-sm text-muted-foreground">From</span>
      {props.mailboxes.length > 1 ? (
        <MenuTrigger>
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
                {labelOf(m.id) && <MenuDescription>{labelOf(m.id)}</MenuDescription>}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : (
        <span className="min-w-0 truncate ps-2 text-sm">{address}</span>
      )}
    </div>
  );
}

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
          "flex flex-col bg-background outline-hidden",
          props.flat ? "" : "rounded-xl border shadow-raised",
          props.fill ? "min-h-0 flex-1" : "",
          props.fill ? "[--composer-row:--spacing(13)]" : "[--composer-row:--spacing(12)]",
          isDropTarget ? (props.flat ? "ring-1 ring-ring ring-inset" : "border-ring") : "",
        ].join(" ")
      }
    >
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
      className={`${props.fill ? "min-h-24 flex-1" : "max-h-[min(24rem,30vh)] min-h-24"} resize-none overscroll-contain px-3 pt-3 pb-1 sm:px-3 sm:pt-3 sm:pb-1`}
    />
  );
}
