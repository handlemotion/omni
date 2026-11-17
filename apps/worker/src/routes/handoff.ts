import { MAX_SEND_ATTACHMENTS } from "@omni/contracts";
import { enqueueHandoff, forMember, undoSendSeconds } from "@omni/db";
import { replySubject } from "@omni/mail-core/compose";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { fanOut } from "../realtime.ts";
import { zValidator } from "../validator.ts";
import {
  attachmentList,
  fromName,
  newMessageId,
  optionalList,
  recipients,
  sendUnlessStale,
  threadMessage,
} from "./compose.ts";
import { idempotencyHeader, notFound, outboxKey, pingLater } from "./mail.ts";
import { basedOnMessageId } from "./reply-precondition.ts";

const handoffBody = z.object({
  mailboxId: z.string().min(1),
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  text: z.string().min(1).max(1_000_000),
  html: z.string().max(2_000_000).optional(),
  messageId: z.string().min(1).optional(),
  basedOnMessageId,
  attachments: attachmentList,
});

async function sendHandoff(
  c: Context<AppEnv>,
  threadId: string,
  body: z.output<typeof handoffBody>,
  key: string,
) {
  const { found, message } = await threadMessage(c, threadId, body);
  if (found.mailboxKind !== "shared") {
    throw new HTTPException(409, { message: "only a shared conversation can be handed off" });
  }
  const mailbox = (await forMember(c.var.db, c.var.member.id).listMailboxes()).find(
    (m) =>
      m.id === body.mailboxId &&
      m.orgId === found.orgId &&
      m.kind === "personal" &&
      m.role === "owner" &&
      m.status === "active",
  );
  if (!mailbox) notFound();
  if (body.attachments.length > MAX_SEND_ATTACHMENTS) {
    throw new HTTPException(400, {
      message: `a message carries at most ${MAX_SEND_ATTACHMENTS} attachments`,
    });
  }
  const name = await fromName(c, "personal");
  const result = await enqueueHandoff(c.var.db, {
    threadId,
    memberId: c.var.member.id,
    send: {
      orgId: mailbox.orgId,
      mailboxId: mailbox.id,
      memberId: c.var.member.id,
      requestId: c.var.requestId,
      idempotencyKey: outboxKey(c, key, "send"),
      kind: "send",
      payload: {
        from: mailbox.address,
        ...(name ? { fromName: name } : {}),
        to: body.to,
        ...optionalList("cc", body.cc),
        ...optionalList("bcc", body.bcc),
        subject: replySubject(message.subject),
        text: body.text,
        ...(body.html ? { html: body.html } : {}),
        inReplyTo: message.messageIdHeader,
        references: [...message.references, message.messageIdHeader],
        ...(body.attachments.length ? { attachments: body.attachments } : {}),
        handoffThreadId: threadId,
        messageId: newMessageId(mailbox.address),
      },
    },
    attachments: body.attachments,
    delaySeconds: await undoSendSeconds(c.var.db, c.var.member.id),
  });
  if (!result.ok) {
    if (result.reason === "invalid_attachments") {
      throw new HTTPException(400, { message: "attachments not available to this mailbox" });
    }
    notFound();
  }
  pingLater(c);
  if (result.changed) {
    const { mailboxId, id } = result.conversation;
    c.executionCtx.waitUntil(
      fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
    );
  }
  return result.action;
}

export const handoff = new Hono<AppEnv>().post(
  "/threads/:id/handoff",
  limitPerMember("send"),
  zValidator("header", idempotencyHeader),
  zValidator("json", handoffBody),
  (c) => {
    const key = c.req.valid("header")["idempotency-key"];
    return sendUnlessStale(c, key, () =>
      sendHandoff(c, c.req.param("id"), c.req.valid("json"), key),
    );
  },
);
