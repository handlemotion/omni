import type { Mailbox, Thread } from "@omni/client";
import { router } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, Alert, StyleSheet, View } from "react-native";
import {
  IconImage,
  IconPaperclip,
  IconReply,
  IconReplyAll,
  IconTrash,
} from "@/components/icons.ts";
import { ChipButton } from "@/components/ui/chip-button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { ApiError } from "@/lib/api.ts";
import {
  notAddresses,
  parseAddresses,
  participantNames,
  replyStart,
  useSendNew,
  useSendReply,
} from "@/lib/compose.ts";
import { useComposeAttachments } from "@/lib/compose-attachments.ts";
import { idempotencyKey } from "@/lib/ids.ts";
import { useMailboxes } from "@/lib/mail.ts";
import { currentWorkspaceId } from "@/lib/workspace-id.ts";
import { gutter, space, text as type } from "@/theme/tokens.ts";
import { AttachmentChips } from "./attachment-chips.tsx";
import { ComposeSheet } from "./compose-sheet.tsx";
import { FromPicker } from "./from-picker.tsx";
import { HeaderRow } from "./header-field.tsx";
import { RecipientField } from "./recipient-field.tsx";

const BODY_MAX = 1_000_000;
const SUBJECT_MAX = 998;

const KINDS = {
  reply: { icon: IconReply, label: "Reply" },
  replyAll: { icon: IconReplyAll, label: "Reply all" },
} as const;
type Kind = keyof typeof KINDS;

interface Copies {
  to: string[];
  cc: string[];
  bcc: string[];
}

type Typed = Record<keyof Copies, string>;
const NOTHING_TYPED: Typed = { to: "", cc: "", bcc: "" };

const withTyped = (list: string[], typed: string) => [
  ...list,
  ...parseAddresses(typed).filter((a) => !list.some((v) => v.toLowerCase() === a.toLowerCase())),
];

function useRecipients(start: { to: string[]; cc: string[] }) {
  const [list, setList] = useState<Copies>({ to: start.to, cc: start.cc, bcc: [] });
  const [typed, setTyped] = useState<Typed>(NOTHING_TYPED);
  const [initial, setInitial] = useState<Copies>(list);
  const [showCopies, setShowCopies] = useState(start.cc.length > 0);
  const final: Copies = {
    to: withTyped(list.to, typed.to),
    cc: withTyped(list.cc, typed.cc),
    bcc: withTyped(list.bcc, typed.bcc),
  };
  return {
    list,
    typed,
    type: (field: keyof Copies, text: string) => setTyped((now) => ({ ...now, [field]: text })),
    final,
    unsendable: Object.values(typed).some((text) => notAddresses(text).length > 0),
    showCopies,
    showAll: () => setShowCopies(true),
    set: (next: Partial<Copies>) => setList((now) => ({ ...now, ...next })),
    changed:
      JSON.stringify(list) !== JSON.stringify(initial) ||
      Object.values(typed).some((text) => text.trim()),
    reset: (next: { to: string[]; cc: string[] }) => {
      const fresh = { to: next.to, cc: next.cc, bcc: [] };
      setList(fresh);
      setTyped(NOTHING_TYPED);
      setInitial(fresh);
      if (next.cc.length) setShowCopies(true);
    },
  };
}

type RecipientsState = ReturnType<typeof useRecipients>;

function useSendKey() {
  const last = useRef<{ payload: string; key: string } | null>(null);
  return (payload: unknown) => {
    const json = JSON.stringify(payload);
    if (last.current?.payload !== json) last.current = { payload: json, key: idempotencyKey() };
    return last.current.key;
  };
}

type Files = ReturnType<typeof useComposeAttachments>;

function confirmDiscard(dirty: boolean, then: () => void) {
  if (!dirty) return then();
  Alert.alert("Discard this message?", undefined, [
    { text: "Keep editing", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: then },
  ]);
}

function Recipients(props: {
  state: RecipientsState;
  autoFocus?: boolean;
  names?: ReadonlyMap<string, string>;
}) {
  const { state, names } = props;
  return (
    <>
      <RecipientField
        label="To"
        value={state.list.to}
        text={state.typed.to}
        onText={(text) => state.type("to", text)}
        autoFocus={props.autoFocus}
        onChange={(to) => state.set({ to })}
        names={names}
        end={
          state.showCopies ? null : (
            <ChipButton label="Cc Bcc" tone="mutedForeground" onPress={state.showAll} />
          )
        }
      />
      {state.showCopies ? (
        <>
          <RecipientField
            label="Cc"
            value={state.list.cc}
            text={state.typed.cc}
            onText={(text) => state.type("cc", text)}
            onChange={(cc) => state.set({ cc })}
            names={names}
          />
          <RecipientField
            label="Bcc"
            value={state.list.bcc}
            text={state.typed.bcc}
            onText={(text) => state.type("bcc", text)}
            onChange={(bcc) => state.set({ bcc })}
            names={names}
          />
        </>
      ) : null}
    </>
  );
}

function Body(props: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      variant="bare"
      label={props.label}
      placeholder="Write…"
      multiline
      scrollEnabled={false}
      autoFocus={props.autoFocus}
      maxLength={BODY_MAX}
      value={props.value}
      onChangeText={props.onChange}
      containerStyle={styles.fill}
      style={styles.body}
    />
  );
}

function KindMenu({ kind, onChange }: { kind: Kind; onChange: (next: Kind) => void }) {
  const current = KINDS[kind];
  const ids = Object.keys(KINDS) as Kind[];
  return (
    <IconButton
      size="toolbar"
      tone="foreground"
      icon={current.icon}
      label={`${current.label}, change`}
      onPress={() =>
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [...ids.map((id) => KINDS[id].label), "Cancel"],
            cancelButtonIndex: ids.length,
          },
          (index) => {
            const next = ids[index];
            if (next && next !== kind) onChange(next);
          },
        )
      }
    />
  );
}

function Toolbar(props: { files: Files; kind?: ReactNode; onDiscard: () => void }) {
  return (
    <>
      <IconButton
        size="toolbar"
        tone="foreground"
        icon={IconPaperclip}
        label="Attach file"
        onPress={props.files.attachFiles}
      />
      <IconButton
        size="toolbar"
        tone="foreground"
        icon={IconImage}
        label="Attach photo"
        onPress={props.files.attachMedia}
      />
      {props.kind}
      <View style={styles.fill} />
      <IconButton size="toolbar" icon={IconTrash} label="Discard" onPress={props.onDiscard} />
    </>
  );
}

function notSent(error: Error, sendAnyway?: () => void) {
  if (sendAnyway && error instanceof ApiError && error.status === 409) {
    Alert.alert("New message in this conversation", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Send anyway", onPress: sendAnyway },
    ]);
    return;
  }
  Alert.alert("Not sent", error.message);
}

/** The web's reply composer in a sheet: From, To (Cc, Bcc), the subject, the reply, files, Send. */
export function ReplyComposer(props: { thread: Thread; replyAll: boolean }) {
  const [thread] = useState(props.thread);
  const [kind, setKind] = useState<Kind>(props.replyAll ? "replyAll" : "reply");
  const start = replyStart(thread, kind === "replyAll");
  const recipients = useRecipients(start);
  const [names] = useState(() => participantNames(thread));
  const mailboxes = useMailboxes();
  const files = useComposeAttachments(thread.mailboxId);
  const [text, setText] = useState("");
  const send = useSendReply();
  const keyFor = useSendKey();
  const message = start.message;
  const written = text.trim().length > 0;
  const dirty = written || recipients.changed || files.list.length > 0;
  const canSend =
    !!message &&
    recipients.final.to.length > 0 &&
    !recipients.unsendable &&
    written &&
    !files.pending &&
    !send.isPending;
  const close = () => confirmDiscard(dirty, () => router.back());
  const submit = (checkLatest: boolean) => {
    if (!message) return;
    const reply = {
      threadId: thread.id,
      messageId: message.id,
      replyAll: kind === "replyAll",
      text,
      attachments: files.attachments,
      ...recipients.final,
    };
    send.mutate(
      { ...reply, key: keyFor(reply), workspace: currentWorkspaceId(), checkLatest },
      {
        onSuccess: () => router.back(),
        onError: (error) => notSent(error, checkLatest ? () => submit(false) : undefined),
      },
    );
  };
  return (
    <ComposeSheet
      dirty={dirty}
      from={
        <FromPicker
          mailboxes={mailboxes.data ?? []}
          value={thread.mailboxId}
          address={thread.mailboxAddress}
        />
      }
      canSend={canSend}
      isSending={send.isPending}
      onSend={() => submit(true)}
      onClose={close}
      toolbar={
        <Toolbar
          files={files}
          onDiscard={close}
          kind={
            <KindMenu
              kind={kind}
              onChange={(next) => {
                setKind(next);
                recipients.reset(replyStart(thread, next === "replyAll"));
              }}
            />
          }
        />
      }
    >
      <Recipients state={recipients} names={names} />
      {start.subject ? (
        <HeaderRow>
          <Text size="body" numberOfLines={1} style={styles.fill}>
            {start.subject}
          </Text>
        </HeaderRow>
      ) : null}
      <Body label="Reply" value={text} onChange={setText} autoFocus />
      <AttachmentChips list={files.list} onRemove={files.remove} />
    </ComposeSheet>
  );
}

/** The web's new-message composer in a sheet: From, To (Cc, Bcc), Subject, the message, files, Send. */
export function NewComposer(props: { mailboxes: Mailbox[]; mailboxId?: string }) {
  const { mailboxes } = props;
  const recipients = useRecipients({ to: [], cc: [] });
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const send = useSendNew();
  const keyFor = useSendKey();
  const [fromId, setFromId] = useState(
    mailboxes.find((m) => m.id === props.mailboxId)?.id ?? mailboxes[0]?.id ?? "",
  );
  const files = useComposeAttachments(fromId);
  const { to } = recipients.final;
  const dirty = !!(text.trim() || subject.trim()) || recipients.changed || files.list.length > 0;
  const canSend =
    !!fromId && to.length > 0 && !recipients.unsendable && !files.pending && !send.isPending;
  const close = () => confirmDiscard(dirty, () => router.back());
  const submit = () => {
    const mail = {
      mailboxId: fromId,
      subject: subject.trim(),
      text,
      attachments: files.attachments,
      ...recipients.final,
    };
    send.mutate(
      { ...mail, key: keyFor(mail), workspace: currentWorkspaceId() },
      { onSuccess: () => router.back(), onError: (error) => notSent(error) },
    );
  };
  return (
    <ComposeSheet
      dirty={dirty}
      from={<FromPicker mailboxes={mailboxes} value={fromId} onChange={setFromId} />}
      canSend={canSend}
      isSending={send.isPending}
      onSend={submit}
      onClose={close}
      toolbar={<Toolbar files={files} onDiscard={close} />}
    >
      <Recipients state={recipients} autoFocus />
      <HeaderRow>
        <TextField
          variant="bare"
          label="Subject"
          placeholder="Subject"
          maxLength={SUBJECT_MAX}
          value={subject}
          onChangeText={setSubject}
          containerStyle={styles.fill}
          style={type.body}
        />
      </HeaderRow>
      <Body label="Message" value={text} onChange={setText} />
      <AttachmentChips list={files.list} onRemove={files.remove} />
    </ComposeSheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  body: { ...type.body, lineHeight: space(6), flex: 1, minHeight: space(24), padding: gutter },
});
