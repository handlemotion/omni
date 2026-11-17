import type { SendAttachment, SendPayload } from "@omni/contracts";
import {
  applyAgentReply,
  cancelSend,
  createDraft,
  createUpload,
  deleteDraft,
  getDraft,
  listDrafts,
  memberSendByKey,
  saveDraft,
  undoSendSeconds,
  deleteUnsentUpload,
  forMember,
  enqueueSendWithAttachments,
  memberMailbox,
  memberUpload,
  newUploadId,
  senderIdentity,
  threadActionTargets,
  uploadKey,
} from "@omni/db";
import { MAX_SEND_ATTACHMENTS, sendAttachmentSchema } from "@omni/contracts";
import {
  forwardBody,
  forwardSubject,
  replyRecipients,
  replySubject,
} from "@omni/mail-core/compose";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError, errorBody } from "../errors.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { optionalJsonBody, zValidator } from "../validator.ts";
import { fanOut, notifyMembers } from "../realtime.ts";
import { assertLatest, basedOnMessageId, StaleThread } from "./reply-precondition.ts";
import { attachmentResponse } from "./assets.ts";
import { idempotencyHeader, notFound, outboxKey, pingLater, type ActionMailbox } from "./mail.ts";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const address = z.email();
export const recipients = z.array(address).max(100);
export const attachmentList = z.array(sendAttachmentSchema).max(50).default([]);

const sendBody = z.object({
  mailboxId: z.string().min(1),
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(2_000_000).optional(),
  attachments: attachmentList,
});

const replyBody = z.object({
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

const forwardBodySchema = z.object({
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

const uploadQuery = z.object({
  mailboxId: z.string().min(1),
  filename: z.string().trim().min(1).max(255),
});

/** Chosen here so a send can return it before the mail goes out. */
export function newMessageId(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
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

/** The From display name: the agent, and on a shared inbox the team they write for. */
export async function fromName(c: Context<AppEnv>, mailboxKind: "personal" | "shared") {
  const identity = await senderIdentity(c.var.db, c.var.member.id);
  if (!identity?.name) return undefined;
  return mailboxKind === "shared" ? `${identity.name} from ${identity.orgName}` : identity.name;
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
  const name = await fromName(c, mailbox.kind);
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
    const earlier = await memberSendByKey(c.var.db, c.var.member.id, outboxKey(c, key, "send"));
    if (earlier) return c.json(sendResponse(earlier), 202);
    return c.json({ ...errorBody(c, "conflict", error.message), messages: error.messages }, 409);
  }
}

type SendBody = z.output<typeof sendBody>;
type ReplyBody = z.output<typeof replyBody>;
type ForwardBody = z.output<typeof forwardBodySchema>;

async function sendNew(c: Context<AppEnv>, body: SendBody, key: string, draftId?: string) {
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

async function sendReply(
  c: Context<AppEnv>,
  threadId: string,
  body: ReplyBody,
  key: string,
  draftId?: string,
) {
  const { found, message } = await threadMessage(c, threadId, body);
  const defaults = replyRecipients(message, found.mailboxAddress, body.replyAll);
  const defaultTo = defaults.to;
  const defaultCc = defaults.cc;
  const to = body.to ?? defaultTo;
  const cc = body.to || body.cc ? (body.cc ?? []) : defaultCc;

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

async function sendForward(
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

const draftAddress = z.object({ name: z.string().max(200).nullable().default(null), address });
const draftAttachment = z.union([
  z.object({ uploadId: z.string().min(1) }),
  z.object({ attachmentId: z.string().min(1) }),
]);
const draftContent = z.object({
  to: z.array(draftAddress).max(100),
  cc: z.array(draftAddress).max(100),
  bcc: z.array(draftAddress).max(100),
  subject: z.string().max(998),
  bodyText: z.string().max(1_000_000),
  bodyHtml: z.string().max(2_000_000).nullable(),
  attachments: z.array(draftAttachment).max(50),
});
const createDraftBody = draftContent.partial().extend({
  mailboxId: z.string().min(1),
  kind: z.enum(["new", "reply", "forward"]),
  threadId: z.string().min(1).optional(),
  sourceMessageId: z.string().min(1).optional(),
});
const saveDraftBody = draftContent.partial().extend({
  version: z.number().int().positive(),
});

function toSendAttachments(list: { uploadId?: string; attachmentId?: string }[]) {
  return list.flatMap((a) => {
    const result: SendAttachment[] = a.uploadId
      ? [{ kind: "upload", uploadId: a.uploadId }]
      : a.attachmentId
        ? [{ kind: "attachment", attachmentId: a.attachmentId }]
        : [];
    return result;
  }) satisfies SendAttachment[];
}

const addresses = (list: { address: string }[]) => list.map((a) => a.address);

const draftSendBody = z.object({ basedOnMessageId });

async function sendDraft(
  c: Context<AppEnv>,
  draft: NonNullable<Awaited<ReturnType<typeof getDraft>>>,
  key: string,
  basedOnMessageId: string | undefined,
) {
  const content = {
    cc: addresses(draft.cc),
    bcc: addresses(draft.bcc),
    attachments: toSendAttachments(draft.attachments),
  };
  if (draft.kind !== "new" && !draft.threadId) notFound();
  if (draft.kind !== "reply" && draft.to.length === 0) {
    throw new HTTPException(400, { message: "add a recipient" });
  }
  if (draft.kind === "reply" && !draft.bodyText.trim()) {
    throw new HTTPException(400, { message: "the reply is empty" });
  }
  const html = draft.bodyHtml ?? undefined;
  return draft.kind === "new"
    ? await sendNew(
        c,
        {
          mailboxId: draft.mailboxId,
          to: addresses(draft.to),
          subject: draft.subject,
          text: draft.bodyText,
          ...(html ? { html } : {}),
          ...content,
        },
        key,
        draft.id,
      )
    : draft.kind === "reply"
      ? await sendReply(
          c,
          draft.threadId!,
          {
            text: draft.bodyText,
            ...(html ? { html } : {}),
            replyAll: false,
            ...(draft.sourceMessageId ? { messageId: draft.sourceMessageId } : {}),
            basedOnMessageId,
            ...(draft.to.length ? { to: addresses(draft.to), cc: content.cc } : {}),
            ...(!draft.to.length && content.cc.length ? { cc: content.cc } : {}),
            bcc: content.bcc,
            attachments: content.attachments,
          },
          key,
          draft.id,
        )
      : await sendForward(
          c,
          draft.threadId!,
          {
            ...(draft.sourceMessageId ? { messageId: draft.sourceMessageId } : {}),
            basedOnMessageId,
            to: addresses(draft.to),
            cc: content.cc,
            bcc: content.bcc,
            text: draft.bodyText,
            ...(html ? { html } : {}),
            includeAttachments: false,
            attachments: content.attachments,
          },
          key,
          draft.id,
        );
}

export const compose = new Hono<AppEnv>()
  .post("/uploads", limitPerMember("actions"), zValidator("query", uploadQuery), async (c) => {
    const { mailboxId, filename } = c.req.valid("query");
    const size = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) {
      return apiError(c, "length_required", "content-length required");
    }
    if (size > c.var.config.UPLOAD_MAX_BYTES) {
      return apiError(
        c,
        "payload_too_large",
        `file is larger than ${c.var.config.UPLOAD_MAX_BYTES} bytes`,
      );
    }
    const body = c.req.raw.body;
    if (!body) return apiError(c, "bad_request", "empty body");
    const mailbox = await memberMailbox(c.var.db, c.var.member.id, mailboxId);
    if (!mailbox) notFound();

    const id = newUploadId();
    const r2Key = uploadKey({ orgId: mailbox.orgId, mailboxId, id });
    const mimeType =
      c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const { readable, writable } = new FixedLengthStream(size);
    const [stored] = await Promise.all([
      c.env.MAIL_BUCKET.put(r2Key, readable, { httpMetadata: { contentType: mimeType } }),
      body.pipeTo(writable),
    ]);
    if (!stored) throw new Error("upload was not stored");
    const upload = await createUpload(c.var.db, {
      id,
      orgId: mailbox.orgId,
      mailboxId,
      memberId: c.var.member.id,
      filename,
      mimeType,
      size,
      r2Key,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    });
    return c.json(
      {
        id: upload.id,
        filename: upload.filename,
        mimeType: upload.mimeType,
        size: upload.size,
        expiresAt: upload.expiresAt,
      },
      201,
    );
  })

  .get("/uploads/:id", async (c) => {
    const upload = await memberUpload(c.var.db, c.var.member.id, c.req.param("id"));
    if (!upload) notFound();
    const object = await c.env.MAIL_BUCKET.get(upload.r2Key);
    if (!object) notFound();
    return attachmentResponse(object, upload);
  })

  .delete("/uploads/:id", async (c) => {
    const r2Key = await deleteUnsentUpload(c.var.db, c.var.member.id, c.req.param("id"));
    if (!r2Key) notFound();
    c.executionCtx.waitUntil(c.env.MAIL_BUCKET.delete(r2Key));
    return c.body(null, 204);
  })

  .post(
    "/send",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", sendBody),
    async (c) => {
      const action = await sendNew(
        c,
        c.req.valid("json"),
        c.req.valid("header")["idempotency-key"],
      );
      return c.json(sendResponse(action), 202);
    },
  )

  .post(
    "/threads/:id/reply",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", replyBody),
    (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      return sendUnlessStale(c, key, () =>
        sendReply(c, c.req.param("id"), c.req.valid("json"), key),
      );
    },
  )

  .post(
    "/threads/:id/forward",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    zValidator("json", forwardBodySchema),
    (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      return sendUnlessStale(c, key, () =>
        sendForward(c, c.req.param("id"), c.req.valid("json"), key),
      );
    },
  )

  .post("/actions/:id/cancel", async (c) => {
    const result = await cancelSend(c.var.db, c.var.member.id, c.req.param("id"));
    if (!result) notFound();
    if (result === "too_late") {
      return apiError(c, "conflict", "already sent");
    }
    if (result.handoff?.changed) {
      if (result.handoff.queuedActions > 0) pingLater(c);
      const { mailboxId, id, orgId } = result.handoff.conversation;
      c.executionCtx.waitUntil(
        Promise.all([
          fanOut(c.env, c.var.db, c.var.config, new Map([[mailboxId, new Set([id])]])),
          notifyMembers(c.env, c.var.db, {
            orgId,
            threadId: id,
            memberIds: result.handoff.notified,
            kind: "assigned",
          }),
        ]),
      );
    }
    return c.json({ cancelled: true, payload: result.payload });
  })

  .get(
    "/drafts",
    zValidator(
      "query",
      z.object({ mailboxId: z.string().min(1).optional(), threadId: z.string().min(1).optional() }),
    ),
    async (c) =>
      c.json({ drafts: await listDrafts(c.var.db, c.var.member.id, c.req.valid("query")) }),
  )

  .get("/drafts/:id", async (c) => {
    const draft = await getDraft(c.var.db, c.var.member.id, c.req.param("id"));
    if (!draft) notFound();
    return c.json(draft);
  })

  .post("/drafts", zValidator("json", createDraftBody), async (c) => {
    const body = c.req.valid("json");
    let { attachments } = body;
    let sourceMessageId = body.sourceMessageId;
    if (body.kind === "forward" && body.threadId) {
      const thread = await forMember(c.var.db, c.var.member.id).getThread(body.threadId);
      const source = sourceMessageId
        ? thread?.messages.find((m) => m.id === sourceMessageId)
        : thread?.messages.at(-1);
      if (!source) notFound();
      sourceMessageId = source.id;
      attachments ??= source.attachments
        .filter((a) => !a.inline)
        .map((a) => ({ attachmentId: a.id }));
    }
    const draft = await createDraft(c.var.db, c.var.member.id, {
      ...body,
      sourceMessageId,
      attachments,
    });
    if (!draft) notFound();
    return c.json(draft, 201);
  })

  .put("/drafts/:id", zValidator("json", saveDraftBody), async (c) => {
    const { version, ...content } = c.req.valid("json");
    const saved = await saveDraft(c.var.db, c.var.member.id, c.req.param("id"), version, content);
    if (!saved) notFound();
    if ("conflict" in saved) {
      return c.json({ ...errorBody(c, "conflict", "draft changed"), draft: saved.conflict }, 409);
    }
    return c.json(saved.draft);
  })

  .delete("/drafts/:id", async (c) => {
    if (!(await deleteDraft(c.var.db, c.var.member.id, c.req.param("id")))) notFound();
    return c.body(null, 204);
  })

  .post(
    "/drafts/:id/send",
    limitPerMember("send"),
    zValidator("header", idempotencyHeader),
    async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const draft = await getDraft(c.var.db, c.var.member.id, c.req.param("id"));
      if (!draft) {
        const earlier = await memberSendByKey(c.var.db, c.var.member.id, outboxKey(c, key, "send"));
        if (!earlier) notFound();
        return c.json(sendResponse(earlier), 202);
      }
      const { basedOnMessageId } = await optionalJsonBody(c, draftSendBody);
      return sendUnlessStale(c, key, () => sendDraft(c, draft, key, basedOnMessageId));
    },
  );
