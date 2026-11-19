import type { Thread } from "@omni/client";
import { replyRecipients, replySubject } from "@omni/mail-core/compose";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { api, ApiError, call, inWorkspace } from "./api.ts";
import { keys } from "./query-keys.ts";

const header = (key: string) => ({ "idempotency-key": key });
const retry = (count: number, error: Error) =>
  error instanceof ApiError && error.status === 0 && count < 3;

/** Addresses typed into a field: split on commas, semicolons and whitespace, empties dropped. */
export function parseAddresses(typed: string) {
  return typed
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when every typed address looks like one (the Worker checks them properly). */
export const allAddresses = (addresses: string[]) => addresses.every((a) => ADDRESS.test(a));

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

/** True when reply all would add someone a plain reply leaves out. */
export const canReplyAll = (thread: Thread) => replyStart(thread, true).cc.length > 0;

interface Recipients {
  workspace: string | null;
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
              attachments: [],
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
    mutationFn: ({ key, mailboxId, subject, text, to, cc, bcc, workspace }: NewMailVariables) =>
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
              attachments: [],
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
