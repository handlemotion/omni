// CRM forwarding address (ADR 0032): the owner of a personal mailbox, in any workspace, sends
// copies of their mail to a CRM's forwarding address. The mail service does the sending.
import { forwardingFor } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";

const forwardingBody = z.object({
  address: z.email().max(254),
  /** `sent`: what you send. `conversations`: and replies in threads you wrote in. `all`: and the Inbox. */
  scope: z.enum(["sent", "conversations", "all"]).default("conversations"),
});

export const forwarding = new Hono<AppEnv>()
  /** Every personal mailbox you own, across your workspaces, with its forwarding and status. */
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
    // Copies sent to the mailbox itself would come back as new mail, forever.
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
  });
