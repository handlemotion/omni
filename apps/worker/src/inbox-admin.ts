import { isManager, recordInboxEvent, type InboxAuditAction } from "@omni/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";

/** Owners and admins of the workspace; a member gets 403 with `refusal`. */
export function managersOnly(refusal: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isManager(c.var.member.role)) throw new HTTPException(403, { message: refusal });
    await next();
  });
}

export const requireManager = managersOnly("only owners and admins manage inboxes");

/** Records an inbox action by the signed-in owner or admin. */
export function logInboxAction(
  c: Context<AppEnv>,
  action: InboxAuditAction,
  address: string,
  data: { mailboxId: string; memberIds?: string[]; invitationId?: string },
) {
  return recordInboxEvent(c.var.db, {
    orgId: c.var.member.orgId,
    actorMemberId: c.var.member.id,
    action,
    address,
    data,
  });
}
