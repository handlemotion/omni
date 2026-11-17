import { recordInboxEvent, workspaceKind, type InboxAuditAction } from "@omni/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./context.ts";

/** Better Auth stores several roles as a comma list. */
export function canManage(role: string) {
  return role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");
}

/** Owners and admins of a company workspace; a member gets 403, a Personal space 404. */
export const requireCompanyManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!canManage(c.var.member.role)) {
    throw new HTTPException(403, { message: "only owners and admins manage inboxes" });
  }
  if ((await workspaceKind(c.var.db, c.var.member.orgId)) === "personal") {
    throw new HTTPException(404, { message: "not found" });
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
