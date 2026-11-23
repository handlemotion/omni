import { isAdmin, recordInboxEvent, type InboxAuditAction } from "@omni/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";

/** Owners and admins of the workspace; a member gets 403. */
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAdmin(c.var.member.role)) {
    throw new HTTPException(403, { message: "only owners and admins manage inboxes" });
  }
  await next();
});

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

/** Owner or admin of the workspace. */
export const canManage = isAdmin;
