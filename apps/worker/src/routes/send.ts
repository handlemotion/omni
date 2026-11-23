import type { SendAttachment, SendPayload } from "@omni/contracts";
import {
  applyAgentReply,
  enqueueSendWithAttachments,
  forMember,
  mailboxSenderName,
  memberMailbox,
  memberSendByKey,
  senderIdentity,
  threadActionTargets,
  undoSendSeconds,
} from "@omni/db";
import { MAX_SEND_ATTACHMENTS, sendAttachmentSchema } from "@omni/contracts";
import {
  forwardBody,
  forwardSubject,
  replyRecipients,
  replySubject,
} from "@omni/mail-core/compose";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { errorBody } from "../errors.ts";
import { fanOut } from "../realtime-announce.ts";
import { assertLatest, basedOnMessageId, StaleThread } from "./reply-precondition.ts";
import { notFound, outboxKey, pingLater, type ActionMailbox } from "./mail.ts";

export const address = z.email();
export const recipients = z.array(address).max(100);
export const attachmentList = z.array(sendAttachmentSchema).max(50).default([]);

export const sendBody = z.object({
  mailboxId: z.string().min(1),
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(2_000_000).optional(),
  attachments: attachmentList,
});

export const replyBody = z.object({
  text: z.string().min(1).max(1_000_000),
  html: z.string().max(2_000_000).optional(),
  replyAll: z.boolean().default(false),
  messageId: z.string().min(1).optional(),
  basedOnMessageId,
  to: recipients.min(1).optional(),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  attachments: attachmentList,
});

export const forwardBodySchema = z.object({
  messageId: z.string().min(1).optional(),
  basedOnMessageId,
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  text: z.string().max(1_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
  includeAttachments: z.boolean().default(true),
  attachments: attachmentList,
});

/** Chosen here so a send can return it before the mail goes out. */
export function newMessageId(from: string) {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * A retried request finds the action it already wrote, so it answers with that send's
 * Message-ID, not the fresh one it just made. The thread's message carries the same id once
 * the mail service stores the sent copy.
 */
export function sendResponse(action: {
  id: string;
  orgId: string;
  payload: Record<string, unknown>;
  runAfter: Date;
}) {
  return {
    actionId: action.id,
    orgId: action.orgId,
    messageIdHeader: (action.payload as SendPayload).messageId ?? null,
    undoUntil: action.runAfter,
  };
}

/**
 * The From display name: on a personal inbox the sender name set for it, else the agent; on a
 * shared inbox the agent and the team they write for.
 */
export async function fromName(
  c: Context<AppEnv>,
  mailbox: { id: string; kind: "personal" | "shared" },
) {
  if (mailbox.kind === "personal") {
    const set = await mailboxSenderName(c.var.db, c.var.member.id, mailbox.id);
    if (set) return set;
  }
  const identity = await senderIdentity(c.var.db, c.var.member.id);
  if (!identity?.name) return undefined;
  return mailbox.kind === "shared" ? `${identity.name} from ${identity.orgName}` : identity.name;
}

/**
 * Queues one send. Refuses (400) attachments the mailbox may not carry; the uploads it takes are
 * marked used in the same transaction, so a delete or the expiry cleanup cannot remove them.
 */
export async function enqueueSend(
  c: Context<AppEnv>,
  mailbox: ActionMailbox & { kind: "personal" | "shared" },
  payload: Omit<SendPayload, "fromName" | "messageId" | "attachments"> & {
    attachments: SendAttachment[];
  },
  key: string,
  draftId?: string,
) {
  const { attachments, ...rest } = payload;
  if (attachments.length > MAX_SEND_ATTACHMENTS) {
    throw new HTTPException(400, {
      message: `a message carries at most ${MAX_SEND_ATTACHMENTS} attachments`,
    });
  }
  const name = await fromName(c, { id: mailbox.mailboxId, kind: mailbox.kind });
  const result = await enqueueSendWithAttachments(
    c.var.db,
    {
      orgId: mailbox.orgId,
      mailboxId: mailbox.mailboxId,
      memberId: c.var.member.id,
      requestId: c.var.requestId,
      idempotencyKey: outboxKey(c, key, "send"),
      kind: "send",
      payload: {
        ...rest,
        ...(name ? { fromName: name } : {}),
        ...(attachments.length ? { attachments } : {}),
        messageId: newMessageId(payload.from),
      },
    },
    attachments,
    {
      delaySeconds: await undoSendSeconds(c.var.db, c.var.member.id),
      ...(draftId ? { draftId } : {}),
    },
  );
  if ("invalid" in result) {
    throw new HTTPException(400, { message: "attachments not available to this mailbox" });
  }
  if ("draftGone" in result) notFound();
  pingLater(c);
  return result.action;
}

async function afterAgentReply(c: Context<AppEnv>, threadId: string) {
  const result = await applyAgentReply(c.var.db, {
    threadId,
    memberId: c.var.member.id,
    requestId: c.var.requestId,
  });
  if (!result.ok || !result.changed) return;
  if (result.queuedActions > 0) pingLater(c);
  const { mailboxId, id } = result.conversation;
  c.executionCtx.waitUntil(
    fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
  );
}

/** Drops empty optional recipient lists so payloads stay as small as before. */
export function optionalList(name: "cc" | "bcc", list: string[] | undefined) {
  return list?.length ? { [name]: list } : {};
}

/**
 * The thread with the chosen message (or its latest), and where its actions run. Throws
 * `StaleThread` when the composer's `basedOnMessageId` is no longer the latest.
 */
export async function threadMessage(
  c: Context<AppEnv>,
  threadId: string,
  body: { messageId?: string; basedOnMessageId?: string },
) {
  const [thread, found] = await Promise.all([
    forMember(c.var.db, c.var.member.id).getThread(threadId),
    threadActionTargets(c.var.db, c.var.member.id, threadId),
  ]);
  const message = body.messageId
    ? thread?.messages.find((m) => m.id === body.messageId)
    : thread?.messages.at(-1);
  if (!thread || !found || !message) notFound();
  assertLatest(thread.messages, body.basedOnMessageId);
  return { found, message };
}

/** The send this Idempotency-Key already queued for the member, if any. */
export function earlierSend(c: Context<AppEnv>, key: string) {
  return memberSendByKey(c.var.db, c.var.member.id, outboxKey(c, key, "send"));
}

/**
 * Runs a reply or forward. A newer message answers 409 with it, unless this is a retry of a send
 * already queued under the same Idempotency-Key: that one answers its send, as any retry does.
 */
export async function sendUnlessStale(
  c: Context<AppEnv>,
  key: string,
  send: () => Promise<Parameters<typeof sendResponse>[0]>,
) {
  try {
    return c.json(sendResponse(await send()), 202);
  } catch (error) {
    if (!(error instanceof StaleThread)) throw error;
    const earlier = await earlierSend(c, key);
    if (earlier) return c.json(sendResponse(earlier), 202);
    return c.json({ ...errorBody(c, "conflict", error.message), messages: error.messages }, 409);
  }
}

export type SendBody = z.output<typeof sendBody>;
export type ReplyBody = z.output<typeof replyBody>;
export type ForwardBody = z.output<typeof forwardBodySchema>;

export async function sendNew(c: Context<AppEnv>, body: SendBody, key: string, draftId?: string) {
  const { mailboxId, cc, bcc, ...message } = body;
  const mailbox = await memberMailbox(c.var.db, c.var.member.id, mailboxId);
  if (!mailbox) notFound();
  return enqueueSend(
    c,
    { orgId: mailbox.orgId, mailboxId: mailbox.id, kind: mailbox.kind },
    { from: mailbox.address, ...message, ...optionalList("cc", cc), ...optionalList("bcc", bcc) },
    key,
    draftId,
  );
}

export async function sendReply(
  c: Context<AppEnv>,
  threadId: string,
  body: ReplyBody,
  key: string,
  draftId?: string,
) {
  const { found, message } = await threadMessage(c, threadId, body);
  const defaults = replyRecipients(message, found.mailboxAddress, body.replyAll);
  const to = body.to ?? defaults.to;
  const cc = body.to || body.cc ? (body.cc ?? []) : defaults.cc;

  const action = await enqueueSend(
    c,
    { orgId: found.orgId, mailboxId: found.mailboxId, kind: found.mailboxKind },
    {
      from: found.mailboxAddress,
      to,
      ...optionalList("cc", cc),
      ...optionalList("bcc", body.bcc),
      subject: replySubject(message.subject),
      text: body.text,
      ...(body.html ? { html: body.html } : {}),
      inReplyTo: message.messageIdHeader,
      references: [...message.references, message.messageIdHeader],
      inReplyToMessageId: message.id,
      attachments: body.attachments,
    },
    key,
    draftId,
  );
  await afterAgentReply(c, threadId);
  return action;
}

export async function sendForward(
  c: Context<AppEnv>,
  threadId: string,
  body: ForwardBody,
  key: string,
  draftId?: string,
) {
  const { found, message } = await threadMessage(c, threadId, body);
  const kept: SendAttachment[] = body.includeAttachments
    ? message.attachments
        .filter((a) => !a.inline)
        .map((a) => ({ kind: "attachment", attachmentId: a.id }))
    : [];
  const content = forwardBody(
    { text: body.text, ...(body.html !== undefined ? { html: body.html } : {}) },
    {
      fromName: message.fromName,
      fromAddress: message.fromAddress,
      to: message.to,
      cc: message.cc,
      sentAt: message.sentAt,
      subject: message.subject,
      text: message.cleanText,
    },
  );
  return enqueueSend(
    c,
    { orgId: found.orgId, mailboxId: found.mailboxId, kind: found.mailboxKind },
    {
      from: found.mailboxAddress,
      to: body.to,
      ...optionalList("cc", body.cc),
      ...optionalList("bcc", body.bcc),
      subject: forwardSubject(message.subject),
      ...content,
      references: [...message.references, message.messageIdHeader],
      inReplyToMessageId: message.id,
      attachments: [...kept, ...body.attachments],
    },
    key,
    draftId,
  );
}
