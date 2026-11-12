// What agents reuse when they write (ADR 0021): signatures and canned replies, an inbox's or
// their own, and the customers they write to.
import {
  createCannedReply,
  customerProfile,
  deleteCannedReply,
  deleteSignature,
  getCannedReply,
  listCannedReplies,
  searchCustomers,
  memberSignatures,
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
  /** `inbox`: the mailbox's signature, for everyone on it. `mine`: this member's own. */
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
  /** Applied when the reply is used (through the conversation routes). */
  setStatus: z.enum(["open", "pending", "snoozed", "resolved"]).nullable().default(null),
  /** The inbox's tags (`tags.id`) to add when used. A personal reply adds none. */
  addTagIds: z.array(z.string().min(1)).max(20).default([]),
});

const createCanned = cannedFields.extend({
  /** The inbox the reply belongs to; null (or absent) for the member's own. */
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
  /**
   * The inbox's signature and the member's own on it (each null when unset). The composer
   * inserts the member's own when there is one, else the inbox's.
   */
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

  /** The inbox's replies (with `mailboxId`) and the member's own, by title. */
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

  /**
   * The reply filled in for one conversation: `{{customer.first_name}}`, `{{agent.name}}` and the
   * rest (`TEMPLATE_VARIABLES`). `missing` lists variables with no value and no fallback, so the
   * composer can flag them. `setStatus` and `addTagIds` are for the client to apply through the
   * conversation routes when it sends.
   */
  .post(
    "/canned-replies/:id/render",
    zValidator("json", z.object({ threadId: z.string().min(1) })),
    async (c) => {
      const [reply, context] = await Promise.all([
        getCannedReply(c.var.db, c.var.member.id, c.req.param("id")),
        templateContext(c.var.db, c.var.member.id, c.req.valid("json").threadId),
      ]);
      if (!reply || !context) notFound();
      // An inbox's reply is for its own conversations.
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

  /** Recipient autocomplete: customers of conversations the member can see, by address or name. */
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

  /** The customer sidebar: profile and past conversations across the inboxes the member sees. */
  .get("/customers/:id", async (c) => {
    const profile = await customerProfile(c.var.db, c.var.member.id, c.req.param("id"));
    if (!profile) notFound();
    return c.json(profile);
  });
