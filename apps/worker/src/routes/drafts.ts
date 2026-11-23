import type { SendAttachment } from "@omni/contracts";
import { createDraft, deleteDraft, forMember, getDraft, listDrafts, saveDraft } from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { errorBody, notFound } from "../errors.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { optionalJsonBody, zValidator, idempotencyHeader } from "../validator.ts";
import { basedOnMessageId } from "./reply-precondition.ts";
import {
  address,
  earlierSend,
  sendForward,
  sendNew,
  sendReply,
  sendResponse,
  sendUnlessStale,
} from "./send.ts";

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
const draftSendBody = z.object({ basedOnMessageId });

type Draft = NonNullable<Awaited<ReturnType<typeof getDraft>>>;

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

function assertSendable(draft: Draft) {
  if (draft.kind !== "reply" && draft.to.length === 0) {
    throw new HTTPException(400, { message: "add a recipient" });
  }
  if (draft.kind === "reply" && !draft.bodyText.trim()) {
    throw new HTTPException(400, { message: "the reply is empty" });
  }
}

async function sendDraft(
  c: Context<AppEnv>,
  draft: Draft,
  key: string,
  basedOn: string | undefined,
) {
  const cc = addresses(draft.cc);
  const bcc = addresses(draft.bcc);
  const attachments = toSendAttachments(draft.attachments);
  const html = draft.bodyHtml ? { html: draft.bodyHtml } : {};
  const { threadId } = draft;
  if (draft.kind !== "new" && !threadId) notFound();
  assertSendable(draft);
  if (draft.kind === "new" || !threadId) {
    const message = { subject: draft.subject, text: draft.bodyText, ...html };
    const body = { mailboxId: draft.mailboxId, to: addresses(draft.to), ...message };
    return sendNew(c, { ...body, cc, bcc, attachments }, key, draft.id);
  }
  const source = draft.sourceMessageId ? { messageId: draft.sourceMessageId } : {};
  if (draft.kind === "reply") {
    const recipients = draft.to.length ? { to: addresses(draft.to), cc } : cc.length ? { cc } : {};
    const body = { text: draft.bodyText, ...html, replyAll: false, ...source };
    return sendReply(
      c,
      threadId,
      { ...body, basedOnMessageId: basedOn, ...recipients, bcc, attachments },
      key,
      draft.id,
    );
  }
  const body = { ...source, basedOnMessageId: basedOn, to: addresses(draft.to), cc, bcc };
  return sendForward(
    c,
    threadId,
    { ...body, text: draft.bodyText, ...html, includeAttachments: false, attachments },
    key,
    draft.id,
  );
}

async function forwardSource(c: Context<AppEnv>, body: z.output<typeof createDraftBody>) {
  if (body.kind !== "forward" || !body.threadId) {
    return { sourceMessageId: body.sourceMessageId, attachments: body.attachments };
  }
  const thread = await forMember(c.var.db, c.var.member.id).getThread(body.threadId);
  const source = body.sourceMessageId
    ? thread?.messages.find((m) => m.id === body.sourceMessageId)
    : thread?.messages.at(-1);
  if (!source) notFound();
  return {
    sourceMessageId: source.id,
    attachments:
      body.attachments ??
      source.attachments.filter((a) => !a.inline).map((a) => ({ attachmentId: a.id })),
  };
}

export const drafts = new Hono<AppEnv>()
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
    const draft = await createDraft(c.var.db, c.var.member.id, {
      ...body,
      ...(await forwardSource(c, body)),
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
        const earlier = await earlierSend(c, key);
        if (!earlier) notFound();
        return c.json(sendResponse(earlier), 202);
      }
      const { basedOnMessageId: basedOn } = await optionalJsonBody(c, draftSendBody);
      return sendUnlessStale(c, key, () => sendDraft(c, draft, key, basedOn));
    },
  );
