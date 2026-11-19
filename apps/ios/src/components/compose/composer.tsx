import type { Mailbox, Thread } from "@omni/client";
import { Stack, router } from "expo-router";
import { useState, type ReactNode } from "react";
import { ActionSheetIOS, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Avatar } from "@/components/ui/avatar.tsx";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { PressableRow } from "@/components/ui/pressable-row.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { ApiError } from "@/lib/api.ts";
import {
  allAddresses,
  parseAddresses,
  replyStart,
  useSendNew,
  useSendReply,
} from "@/lib/compose.ts";
import { idempotencyKey } from "@/lib/ids.ts";
import { listTime } from "@/lib/mail.ts";
import { currentWorkspaceId } from "@/lib/workspace-id.ts";
import { colors, gutter, space } from "@/theme/tokens.ts";
import { HeaderField, HeaderRow, addressInput } from "./header-field.tsx";

const BODY_MAX = 1_000_000;
const SUBJECT_MAX = 998;

type Draft = ReturnType<typeof useDraft>;

function useDraft(start: { to: string[]; cc: string[] }) {
  const [to, setTo] = useState(start.to.join(", "));
  const [cc, setCc] = useState(start.cc.join(", "));
  const [bcc, setBcc] = useState("");
  const [body, setBody] = useState("");
  const [showCopies, setShowCopies] = useState(start.cc.length > 0);
  const addresses = { to: parseAddresses(to), cc: parseAddresses(cc), bcc: parseAddresses(bcc) };
  const valid =
    addresses.to.length > 0 && allAddresses([...addresses.to, ...addresses.cc, ...addresses.bcc]);
  return {
    fields: { to, setTo, cc, setCc, bcc, setBcc, body, setBody, showCopies, setShowCopies },
    addresses,
    valid,
    written: body.trim().length > 0,
    dirty:
      body.trim().length > 0 ||
      bcc.trim().length > 0 ||
      to !== start.to.join(", ") ||
      cc !== start.cc.join(", "),
  };
}

function ComposeHeader(props: {
  title: string;
  dirty: boolean;
  canSend: boolean;
  onSend: () => void;
}) {
  const close = () => {
    if (!props.dirty) return router.back();
    Alert.alert("Discard this message?", undefined, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => router.back() },
    ]);
  };
  return (
    <>
      <Stack.Screen options={{ title: props.title, gestureEnabled: !props.dirty }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={close} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="arrow.up"
          variant="prominent"
          accessibilityLabel="Send"
          disabled={!props.canSend}
          onPress={props.onSend}
        />
      </Stack.Toolbar>
    </>
  );
}

function Recipients({ draft, from }: { draft: Draft; from: ReactNode }) {
  const f = draft.fields;
  return (
    <>
      <HeaderField label="To" value={f.to} onChangeText={f.setTo} {...addressInput} />
      {f.showCopies ? (
        <>
          <HeaderField label="Cc" value={f.cc} onChangeText={f.setCc} {...addressInput} />
          <HeaderField label="Bcc" value={f.bcc} onChangeText={f.setBcc} {...addressInput} />
          {from}
        </>
      ) : (
        <PressableRow
          accessibilityLabel="Cc, Bcc and From"
          onPress={() => f.setShowCopies(true)}
          style={styles.collapsed}
        >
          <Text tone="mutedForeground">Cc/Bcc, From</Text>
        </PressableRow>
      )}
    </>
  );
}

function Body({ draft, short }: { draft: Draft; short?: boolean }) {
  return (
    <TextField
      variant="bare"
      label="Message"
      multiline
      scrollEnabled={false}
      autoFocus
      maxLength={BODY_MAX}
      value={draft.fields.body}
      onChangeText={draft.fields.setBody}
      style={[styles.body, short && styles.shortBody]}
    />
  );
}

function Sheet({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.sheet}
    >
      {children}
    </ScrollView>
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

/** A reply to a conversation's latest message, from the inbox it arrived on. */
export function ReplyComposer({ thread, replyAll }: { thread: Thread; replyAll: boolean }) {
  const [start] = useState(() => replyStart(thread, replyAll));
  const draft = useDraft(start);
  const send = useSendReply();
  const [key] = useState(idempotencyKey);
  const message = start.message;
  const canSend = !!message && draft.valid && draft.written && !send.isPending;
  const submit = (checkLatest: boolean) =>
    message &&
    send.mutate(
      {
        key,
        workspace: currentWorkspaceId(),
        threadId: thread.id,
        messageId: message.id,
        checkLatest,
        replyAll,
        text: draft.fields.body,
        ...draft.addresses,
      },
      {
        onSuccess: () => router.back(),
        onError: (error) => notSent(error, checkLatest ? () => submit(false) : undefined),
      },
    );
  const sender = message ? message.fromName || message.fromAddress : "";
  return (
    <Sheet>
      <ComposeHeader
        title={replyAll ? "Reply all" : "Reply"}
        dirty={draft.dirty}
        canSend={canSend}
        onSend={() => submit(true)}
      />
      <Recipients draft={draft} from={<FromRow address={thread.mailboxAddress} />} />
      <HeaderRow label="Subject">
        <Text selectable>{start.subject}</Text>
      </HeaderRow>
      <Body draft={draft} short />
      {message ? (
        <View style={styles.quoted}>
          <ItemRow
            lead={<Avatar name={sender} logo={{ address: message.fromAddress }} size={32} />}
            title={sender}
            detail={message.cleanText.replace(/\s+/g, " ").trim()}
            trailing={listTime(message.sentAt)}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

/** New mail from one of the workspace's mailboxes: `mailboxId` first when given. */
export function NewComposer({
  mailboxes,
  mailboxId,
}: {
  mailboxes: Mailbox[];
  mailboxId?: string;
}) {
  const draft = useDraft({ to: [], cc: [] });
  const send = useSendNew();
  const [key] = useState(idempotencyKey);
  const [subject, setSubject] = useState("");
  const [fromId, setFromId] = useState(
    mailboxes.find((m) => m.id === mailboxId)?.id ?? mailboxes[0]?.id,
  );
  const from = mailboxes.find((m) => m.id === fromId);
  const canSend = !!from && draft.valid && !send.isPending;
  const submit = () =>
    from &&
    send.mutate(
      {
        key,
        workspace: currentWorkspaceId(),
        mailboxId: from.id,
        subject: subject.trim(),
        text: draft.fields.body,
        ...draft.addresses,
      },
      { onSuccess: () => router.back(), onError: (error) => notSent(error) },
    );
  return (
    <Sheet>
      <ComposeHeader
        title="New message"
        dirty={draft.dirty || !!subject.trim()}
        canSend={canSend}
        onSend={submit}
      />
      <Recipients
        draft={draft}
        from={
          <FromRow
            address={from?.address ?? ""}
            choices={mailboxes.map((m) => m.address)}
            onChoose={(index) => setFromId(mailboxes[index]?.id)}
          />
        }
      />
      <HeaderField
        label="Subject"
        multiline
        maxLength={SUBJECT_MAX}
        value={subject}
        onChangeText={setSubject}
      />
      <Body draft={draft} />
    </Sheet>
  );
}

function FromRow(props: {
  address: string;
  choices?: string[];
  onChoose?: (index: number) => void;
}) {
  const { choices, onChoose } = props;
  const pick =
    Platform.OS === "ios" && choices && choices.length > 1 && onChoose
      ? () =>
          ActionSheetIOS.showActionSheetWithOptions(
            { title: "From", options: [...choices, "Cancel"], cancelButtonIndex: choices.length },
            (index) => index < choices.length && onChoose(index),
          )
      : undefined;
  return (
    <PressableRow accessibilityLabel={`From ${props.address}`} onPress={pick} style={styles.from}>
      <Text tone="mutedForeground">From</Text>
      <Text numberOfLines={1} ellipsizeMode="middle" style={styles.fromAddress}>
        {props.address}
      </Text>
    </PressableRow>
  );
}

const rule = { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border };

const styles = StyleSheet.create({
  sheet: { paddingBottom: space(16) },
  collapsed: { minHeight: 52, ...rule },
  from: { minHeight: 52, gap: space(2), ...rule },
  fromAddress: { flex: 1, minWidth: 0 },
  body: { minHeight: 200, paddingHorizontal: gutter, paddingTop: space(4) },
  shortBody: { minHeight: 120 },
  quoted: { marginTop: space(2) },
});
