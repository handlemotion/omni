// What agents reuse when they write (ADR 0021): signatures, an inbox's or their own.
import { deleteSignature, memberSignatures, setSignature } from "@omni/db";
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
  });
