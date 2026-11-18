import { forwardingFor, labelMailbox } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";

const forwardingBody = z.object({
  address: z.email().max(254),
  scope: z.enum(["sent", "conversations", "all"]).default("conversations"),
});

const labelBody = z.object({
  label: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((label) => label || null),
});

export const forwarding = new Hono<AppEnv>()
  .get("/forwarding", async (c) => {
    const reader = forwardingFor(c.var.db, c.var.user.id, c.var.user.scopeOrgId);
    return c.json({ mailboxes: await reader.list() });
  })

  .put("/mailboxes/:id/forwarding", zValidator("json", forwardingBody), async (c) => {
    const reader = forwardingFor(c.var.db, c.var.user.id, c.var.user.scopeOrgId);
    const { address, scope } = c.req.valid("json");
    const id = c.req.param("id");
    const mailbox = (await reader.list()).find((m) => m.mailboxId === id);
    if (!mailbox) throw new HTTPException(404, { message: "mailbox not found" });
    if (address.toLowerCase() === mailbox.address.toLowerCase()) {
      return apiError(c, "bad_request", "forward to another address than the mailbox's own");
    }
    await reader.set(id, { address: address.toLowerCase(), scope });
    return c.json({ ok: true as const });
  })

  .delete("/mailboxes/:id/forwarding", async (c) => {
    const reader = forwardingFor(c.var.db, c.var.user.id, c.var.user.scopeOrgId);
    if (!(await reader.clear(c.req.param("id")))) {
      throw new HTTPException(404, { message: "mailbox not found" });
    }
    return c.json({ ok: true as const });
  })

  .put("/mailboxes/:id/label", zValidator("json", labelBody), async (c) => {
    const labelled = await labelMailbox(c.var.db, {
      userId: c.var.user.id,
      scopeOrgId: c.var.user.scopeOrgId,
      mailboxId: c.req.param("id"),
      label: c.req.valid("json").label,
    });
    if (!labelled) throw new HTTPException(404, { message: "mailbox not found" });
    return c.json({ ok: true as const });
  });
