import type { Thread } from "@omni/client";
import { forwardSubject, replyRecipients, replySubject } from "@omni/mail-core/compose";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { api, ApiError, call, inWorkspace } from "./api.ts";
import { keys } from "./query-keys.ts";

const header = (key: string) => ({ "idempotency-key": key });
const retry = (count: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && count < 3;

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const tokens = (text: string) =>
  [...new Set(text.split(/[\s,;]+/).map((a) => a.replace(/^<|>$/g, "").trim()))].filter(Boolean);

/** Every address in typed or pasted text, in order, without repeats (the web's `parseAddresses`). */
export function parseAddresses(text: string) {
  return tokens(text).filter((a) => ADDRESS.test(a)) satisfies string[];
}

/** What in typed text isn't an address, kept in the field for the person to fix. */
export function notAddresses(text: string) {
  return tokens(text).filter((a) => !ADDRESS.test(a)) satisfies string[];
}

/** What a reply starts from: its recipients, as the Worker would pick them, and its subject. */
export function replyStart(thread: Thread, replyAll: boolean) {
  const latest = thread.messages.at(-1);
  if (!latest) return { to: [], cc: [], subject: "", message: undefined };
  const { to, cc } = replyRecipients(latest, thread.mailboxAddress, replyAll);
  return {
    to,
    cc,
    subject: replySubject(thread.messages[0]?.subject ?? latest.subject),
    message: latest,
  };
}

/**
 * What a forward starts from: the latest message and the subject the Worker gives it. The To is
 * empty, and the Worker quotes the original under what the person writes, as on the web.
 */
export function forwardStart(thread: Thread) {
  const latest = thread.messages.at(-1);
  return { subject: latest ? forwardSubject(latest.subject) : "", message: latest };
}

/** Each address on a conversation with the name its messages give it, lowercased, for chips. */
export function participantNames(thread: Thread) {
  const names = new Map<string, string>();
  const note = (address: string, name?: string | null) => {
    if (name && !names.has(address.toLowerCase())) names.set(address.toLowerCase(), name);
  };
  for (const message of thread.messages) {
    note(message.fromAddress, message.fromName);
    for (const one of [...message.to, ...message.cc]) note(one.address, one.name);
  }
  return names;
}

/** True when reply all would add someone a plain reply leaves out. */
export const canReplyAll = (thread: Thread) => replyStart(thread, true).cc.length > 0;

/** A file going out with the mail: one the person uploaded, or an original's a forward keeps. */
export type SendAttachment =
  | { kind: "upload"; uploadId: string }
  | { kind: "attachment"; attachmentId: string };

interface Recipients {
  workspace: string | null;
  attachments: SendAttachment[];
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface ReplyVariables extends Recipients {
  key: string;
  threadId: string;
  messageId: string;
  /** Refuse (409) when the conversation has a message newer than `messageId`. */
  checkLatest: boolean;
  text: string;
  replyAll: boolean;
}

export interface ForwardVariables extends Recipients {
  key: string;
  threadId: string;
  messageId: string;
  text: string;
}

export interface NewMailVariables extends Recipients {
  key: string;
  mailboxId: string;
  subject: string;
  text: string;
}

const optional = (list: string[]) => (list.length ? list : undefined);

function useSent() {
  const client = useQueryClient();
  return {
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
    settle: (threadId?: string) => {
      void client.invalidateQueries({ queryKey: keys.threadLists() });
      void client.invalidateQueries({ queryKey: keys.counts() });
      if (threadId) void client.invalidateQueries({ queryKey: keys.thread(threadId) });
    },
  };
}

/** Sends a reply on a conversation, to the message it answers. A retry reuses its key. */
export function useSendReply() {
  const sent = useSent();
  return useMutation({
    mutationFn: ({
      key,
      threadId,
      messageId,
      checkLatest,
      text,
      replyAll,
      to,
      cc,
      bcc,
      attachments,
      workspace,
    }: ReplyVariables) =>
      call(
        api.threads[":id"].reply.$post(
          {
            param: { id: threadId },
            header: header(key),
            json: {
              text,
              replyAll,
              messageId,
              basedOnMessageId: checkLatest ? messageId : undefined,
              to,
              cc: optional(cc),
              bcc: optional(bcc),
              attachments,
            },
          },
          inWorkspace(workspace),
        ),
      ),
    retry,
    onSuccess: sent.onSuccess,
    onError: sent.onError,
    onSettled: (_data, _error, { threadId }) => sent.settle(threadId),
  });
}

/** Sends new mail from one of the workspace's mailboxes. A retry reuses its key. */
export function useSendNew() {
  const sent = useSent();
  return useMutation({
    mutationFn: ({
      key,
      mailboxId,
      subject,
      text,
      to,
      cc,
      bcc,
      attachments,
      workspace,
    }: NewMailVariables) =>
      call(
        api.send.$post(
          {
            header: header(key),
            json: {
              mailboxId,
              subject,
              text,
              to,
              cc: optional(cc),
              bcc: optional(bcc),
              attachments,
            },
          },
          inWorkspace(workspace),
        ),
      ),
    retry,
    onSuccess: sent.onSuccess,
    onError: sent.onError,
    onSettled: () => sent.settle(),
  });
}

/**
 * Forwards a conversation's message with what the person wrote above it. The original's files go
 * as `attachments` the person kept, so `includeAttachments` is off, as on the web.
 */
export function useSendForward() {
  const sent = useSent();
  return useMutation({
    mutationFn: ({
      key,
      threadId,
      messageId,
      text,
      to,
      cc,
      bcc,
      attachments,
      workspace,
    }: ForwardVariables) =>
      call(
        api.threads[":id"].forward.$post(
          {
            param: { id: threadId },
            header: header(key),
            json: {
              messageId,
              to,
              cc: optional(cc),
              bcc: optional(bcc),
              text,
              includeAttachments: false,
              attachments,
            },
          },
          inWorkspace(workspace),
        ),
      ),
    retry,
    onSuccess: sent.onSuccess,
    onError: sent.onError,
    onSettled: (_data, _error, { threadId }) => sent.settle(threadId),
  });
}
