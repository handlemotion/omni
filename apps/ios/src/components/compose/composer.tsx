import type { Mailbox, Thread } from "@omni/client";
import { Stack, router } from "expo-router";
import { useRef, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  IconChevronDown,
  IconReply,
  IconReplyAll,
  IconSend,
  IconTrash,
} from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { ApiError } from "@/lib/api.ts";
import {
  notAddresses,
  parseAddresses,
  replyStart,
  useSendNew,
  useSendReply,
} from "@/lib/compose.ts";
import { idempotencyKey } from "@/lib/ids.ts";
import { currentWorkspaceId } from "@/lib/workspace-id.ts";
import { gutter, space } from "@/theme/tokens.ts";
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

function confirmDiscard(dirty: boolean, then: () => void) {
  if (!dirty) return then();
  Alert.alert("Discard this message?", undefined, [
    { text: "Keep editing", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: then },
  ]);
}

function Frame(props: { title: string; dirty: boolean; toolbar: ReactNode; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.frame}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <Stack.Screen options={{ title: props.title, gestureEnabled: !props.dirty }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Close"
          onPress={() => confirmDiscard(props.dirty, () => router.back())}
        />
      </Stack.Toolbar>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
        style={styles.frame}
      >
        {props.children}
      </ScrollView>
      <View style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, space(3)) }]}>
        {props.toolbar}
      </View>
    </KeyboardAvoidingView>
  );
}

function Recipients({ state, autoFocus }: { state: RecipientsState; autoFocus?: boolean }) {
  return (
    <>
      <RecipientField
        label="To"
        value={state.list.to}
        text={state.typed.to}
        onText={(text) => state.type("to", text)}
        autoFocus={autoFocus}
        onChange={(to) => state.set({ to })}
        end={
          state.showCopies ? null : (
            <Button intent="quiet" size="sm" label="Cc Bcc" onPress={state.showAll} />
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
          />
          <RecipientField
            label="Bcc"
            value={state.list.bcc}
            text={state.typed.bcc}
            onText={(text) => state.type("bcc", text)}
            onChange={(bcc) => state.set({ bcc })}
          />
        </>
      ) : null}
    </>
  );
}

function FromRow(props: {
  mailboxes: { id: string; address: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { mailboxes, onChange } = props;
  const address = mailboxes.find((m) => m.id === props.value)?.address ?? "";
  const pick = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...mailboxes.map((m) => m.address), "Cancel"],
        cancelButtonIndex: mailboxes.length,
      },
      (index) => {
        const next = mailboxes[index];
        if (next) onChange(next.id);
      },
    );
  return (
    <HeaderRow label="From">
      {mailboxes.length > 1 && Platform.OS === "ios" ? (
        <Button
          intent="quiet"
          label={address}
          trailingIcon={IconChevronDown}
          accessibilityLabel={`From ${address}`}
          onPress={pick}
          style={styles.shrink}
        />
      ) : (
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.shrink}>
          {address}
        </Text>
      )}
    </HeaderRow>
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

function SendButton(props: { canSend: boolean; isPending: boolean; onSend: () => void }) {
  return (
    <Button
      size="sm"
      icon={IconSend}
      label="Send"
      disabled={!props.canSend}
      isPending={props.isPending}
      onPress={props.onSend}
    />
  );
}

function KindMenu({ kind, onChange }: { kind: Kind; onChange: (next: Kind) => void }) {
  const current = KINDS[kind];
  const ids = Object.keys(KINDS) as Kind[];
  return (
    <Button
      intent="outline"
      size="sm"
      icon={current.icon}
      trailingIcon={IconChevronDown}
      label={current.label}
      accessibilityLabel={`${current.label}, change`}
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

/** The web's reply composer in a sheet: From, To (Cc, Bcc), the reply, then Reply or Reply all, Discard and Send. */
export function ReplyComposer(props: { thread: Thread; replyAll: boolean }) {
  const [thread] = useState(props.thread);
  const [kind, setKind] = useState<Kind>(props.replyAll ? "replyAll" : "reply");
  const start = replyStart(thread, kind === "replyAll");
  const recipients = useRecipients(start);
  const [text, setText] = useState("");
  const send = useSendReply();
  const keyFor = useSendKey();
  const message = start.message;
  const written = text.trim().length > 0;
  const dirty = written || recipients.changed;
  const canSend =
    !!message &&
    recipients.final.to.length > 0 &&
    !recipients.unsendable &&
    written &&
    !send.isPending;
  const submit = (checkLatest: boolean) => {
    if (!message) return;
    const reply = {
      threadId: thread.id,
      messageId: message.id,
      replyAll: kind === "replyAll",
      text,
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
    <Frame
      title={KINDS[kind].label}
      dirty={dirty}
      toolbar={
        <>
          <KindMenu
            kind={kind}
            onChange={(next) => {
              setKind(next);
              recipients.reset(replyStart(thread, next === "replyAll"));
            }}
          />
          <View style={styles.end}>
            <IconButton
              icon={IconTrash}
              label="Discard"
              onPress={() => confirmDiscard(dirty, () => router.back())}
            />
            <SendButton canSend={canSend} isPending={send.isPending} onSend={() => submit(true)} />
          </View>
        </>
      }
    >
      <FromRow
        mailboxes={[{ id: thread.mailboxId, address: thread.mailboxAddress }]}
        value={thread.mailboxId}
        onChange={() => undefined}
      />
      <Recipients state={recipients} />
      <Body label="Reply" value={text} onChange={setText} autoFocus />
    </Frame>
  );
}

/** The web's new-message composer in a sheet: From, To (Cc, Bcc), Subject, the message, then Send. */
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
  const { to } = recipients.final;
  const dirty = !!(text.trim() || subject.trim()) || recipients.changed;
  const canSend = !!fromId && to.length > 0 && !recipients.unsendable && !send.isPending;
  const submit = () => {
    const mail = { mailboxId: fromId, subject: subject.trim(), text, ...recipients.final };
    send.mutate(
      { ...mail, key: keyFor(mail), workspace: currentWorkspaceId() },
      { onSuccess: () => router.back(), onError: (error) => notSent(error) },
    );
  };
  return (
    <Frame
      title="New message"
      dirty={dirty}
      toolbar={
        <>
          <View />
          <SendButton canSend={canSend} isPending={send.isPending} onSend={submit} />
        </>
      }
    >
      <FromRow mailboxes={mailboxes} value={fromId} onChange={setFromId} />
      <Recipients state={recipients} autoFocus />
      <HeaderRow>
        <TextField
          variant="bare"
          label="Subject"
          placeholder="Subject"
          maxLength={SUBJECT_MAX}
          value={subject}
          onChangeText={setSubject}
          containerStyle={styles.shrink}
        />
      </HeaderRow>
      <Body label="Message" value={text} onChange={setText} />
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  content: { flexGrow: 1 },
  fill: { flex: 1 },
  shrink: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: space(24), paddingHorizontal: gutter, paddingTop: space(3) },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(2),
    paddingHorizontal: gutter,
    paddingTop: space(2),
  },
  end: { flexDirection: "row", alignItems: "center", gap: space(3) },
});
