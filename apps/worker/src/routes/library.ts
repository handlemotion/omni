import {
  createCannedReply,
  customerProfile,
  deleteCannedReply,
  deleteSignature,
  getCannedReply,
  listCannedReplies,
  searchCustomers,
  memberSettings,
  memberSignatures,
  NOTIFICATION_KINDS,
  registerPushToken,
  unregisterPushToken,
  updateMemberSettings,
  setSignature,
  templateContext,
  updateCannedReply,
  type CannedReplyWriteError,
} from "@omni/db";
import { firstName, renderTemplate } from "@omni/mail-core/templates";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { notFound } from "./mail.ts";

const scopeQuery = z.object({
  scope: z.enum(["inbox", "mine"]),
});

const signatureBody = z.object({
  bodyText: z.string().max(10_000),
  bodyHtml: z.string().max(50_000).nullable().default(null),
});

const cannedFields = z.object({
  title: z.string().trim().min(1).max(200),
  bodyText: z.string().min(1).max(100_000),
  bodyHtml: z.string().max(500_000).nullable().default(null),
  setStatus: z.enum(["open", "pending", "snoozed", "resolved"]).nullable().default(null),
  addTagIds: z.array(z.string().min(1)).max(20).default([]),
});

const createCanned = cannedFields.extend({
  mailboxId: z.string().min(1).nullable().default(null),
});

const patchCanned = z
  .object({
    title: z.string().trim().min(1).max(200),
    bodyText: z.string().min(1).max(100_000),
    bodyHtml: z.string().max(500_000).nullable(),
    setStatus: z.enum(["open", "pending", "snoozed", "resolved"]).nullable(),
    addTagIds: z.array(z.string().min(1)).max(20),
  })
  .partial();

function writeFailed(error: CannedReplyWriteError): never {
  if (error === "invalid_tags") {
    throw new HTTPException(400, { message: "tags must belong to the reply's inbox" });
  }
  notFound();
}

export const library = new Hono<AppEnv>()
  .get("/mailboxes/:mailboxId/signature", async (c) => {
    const found = await memberSignatures(c.var.db, c.var.member.id, c.req.param("mailboxId"));
    if (!found) notFound();
    return c.json(found);
  })

  .put(
    "/mailboxes/:mailboxId/signature",
    zValidator("query", scopeQuery),
    zValidator("json", signatureBody),
    async (c) => {
      const mailboxId = c.req.param("mailboxId");
      const saved = await setSignature(
        c.var.db,
        c.var.member.id,
        mailboxId,
        c.req.valid("query").scope,
        c.req.valid("json"),
      );
      if (!saved) notFound();
      return c.json(await memberSignatures(c.var.db, c.var.member.id, mailboxId));
    },
  )

  .delete("/mailboxes/:mailboxId/signature", zValidator("query", scopeQuery), async (c) => {
    const mailboxId = c.req.param("mailboxId");
    const removed = await deleteSignature(
      c.var.db,
      c.var.member.id,
      mailboxId,
      c.req.valid("query").scope,
    );
    if (!removed) notFound();
    return c.json(await memberSignatures(c.var.db, c.var.member.id, mailboxId));
  })

  .get(
    "/canned-replies",
    zValidator("query", z.object({ mailboxId: z.string().min(1).optional() })),
    async (c) => {
      const replies = await listCannedReplies(c.var.db, c.var.member.id, c.req.valid("query"));
      return c.json({ replies });
    },
  )

  .post("/canned-replies", zValidator("json", createCanned), async (c) => {
    const result = await createCannedReply(c.var.db, c.var.member.id, c.req.valid("json"));
    if (!("reply" in result)) writeFailed(result.error);
    return c.json(result.reply, 201);
  })

  .patch("/canned-replies/:id", zValidator("json", patchCanned), async (c) => {
    const result = await updateCannedReply(
      c.var.db,
      c.var.member.id,
      c.req.param("id"),
      c.req.valid("json"),
    );
    if (!("reply" in result)) writeFailed(result.error);
    return c.json(result.reply);
  })

  .delete("/canned-replies/:id", async (c) => {
    if (!(await deleteCannedReply(c.var.db, c.var.member.id, c.req.param("id")))) notFound();
    return c.body(null, 204);
  })

  .post(
    "/canned-replies/:id/render",
    zValidator("json", z.object({ threadId: z.string().min(1) })),
    async (c) => {
      const [reply, context] = await Promise.all([
        getCannedReply(c.var.db, c.var.member.id, c.req.param("id")),
        templateContext(c.var.db, c.var.member.id, c.req.valid("json").threadId),
      ]);
      if (!reply || !context) notFound();
      if (reply.mailboxId && reply.mailboxId !== context.mailboxId) notFound();
      const values = {
        "customer.name": context.customer?.name ?? null,
        "customer.first_name": firstName(context.customer?.name),
        "customer.email": context.customer?.address ?? null,
        "customer.company": context.customer?.company ?? null,
        "agent.name": context.agent?.name ?? null,
        "agent.first_name": firstName(context.agent?.name),
        "agent.email": context.agent?.email ?? null,
        "inbox.address": context.inboxAddress,
        "org.name": context.orgName,
      };
      const text = renderTemplate(reply.bodyText, values);
      const html = reply.bodyHtml ? renderTemplate(reply.bodyHtml, values, { html: true }) : null;
      return c.json({
        text: text.text,
        html: html?.text ?? null,
        missing: [...new Set([...text.missing, ...(html?.missing ?? [])])],
        setStatus: reply.setStatus,
        addTagIds: reply.addTagIds,
      });
    },
  )

  .get(
    "/customers",
    zValidator(
      "query",
      z.object({
        q: z.string().trim().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(25).default(10),
      }),
    ),
    async (c) => {
      const { q, limit } = c.req.valid("query");
      return c.json({ customers: await searchCustomers(c.var.db, c.var.member.id, q, limit) });
    },
  )

  .get("/customers/:id", async (c) => {
    const profile = await customerProfile(c.var.db, c.var.member.id, c.req.param("id"));
    if (!profile) notFound();
    return c.json(profile);
  })

  .get("/preferences", async (c) => c.json(await memberSettings(c.var.db, c.var.member.id)))

  .patch(
    "/preferences",
    zValidator(
      "json",
      z.object({
        notifications: z
          .partialRecord(
            z.enum(NOTIFICATION_KINDS),
            z.object({ realtime: z.boolean(), desktop: z.boolean(), push: z.boolean() }).partial(),
          )
          .optional(),
        theme: z.enum(["system", "light", "dark"]).optional(),
        /** 0 sends at once; up to 30 seconds. */
        undoSendSeconds: z.number().int().min(0).max(30).optional(),
      }),
    ),
    async (c) => c.json(await updateMemberSettings(c.var.db, c.var.member.id, c.req.valid("json"))),
  )

  .post(
    "/push-tokens",
    zValidator(
      "json",
      z.object({
        expoToken: z.string().regex(/^(Exponent|Expo)PushToken\[[^\]]+\]$/, "an Expo push token"),
        device: z.string().trim().max(200).nullable().default(null),
      }),
    ),
    async (c) => {
      await registerPushToken(c.var.db, c.var.member, c.req.valid("json"));
      return c.body(null, 204);
    },
  )

  .delete("/push-tokens/:token", async (c) => {
    const removed = await unregisterPushToken(c.var.db, c.var.member.id, c.req.param("token"));
    if (!removed) notFound();
    return c.body(null, 204);
  });
