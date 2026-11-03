// Who can see a shared mailbox (ADR 0008). Its Better Auth team is the list; adding or removing
// a member here changes the team and the derived `mailbox_access` grants in one transaction.
// Org owners and admins manage the list; anyone who can see the mailbox can read it.
import {
  addMailboxMember,
  listMailboxMembers,
  removeMailboxMember,
  type MailboxMembersActor,
  type MailboxMembershipResult,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context.ts";

/** Better Auth stores several roles as a comma list. */
function canManage(role: string) {
  return role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");
}

function actor(c: Context<AppEnv>): MailboxMembersActor {
  const { id, orgId, role } = c.var.member;
  return { memberId: id, orgId, manage: canManage(role) };
}

function requireManager(c: Context<AppEnv>) {
  const who = actor(c);
  if (!who.manage) {
    throw new HTTPException(403, { message: "only owners and admins manage mailbox members" });
  }
  return who;
}

function answer(c: Context<AppEnv>, result: MailboxMembershipResult) {
  if (result === "mailbox_not_found") throw new HTTPException(404, { message: "not found" });
  if (result === "member_not_found") {
    throw new HTTPException(404, { message: "no such member in this organization" });
  }
  return c.json({ ok: true as const });
}

export const mailboxMembers = new Hono<AppEnv>()
  /** The shared mailbox's members, oldest first. 404 for a personal mailbox. */
  .get("/mailboxes/:id/members", async (c) => {
    const members = await listMailboxMembers(c.var.db, actor(c), c.req.param("id"));
    if (!members) throw new HTTPException(404, { message: "not found" });
    return c.json({ members });
  })

  /** Grants access. Idempotent: adding a member already on the list changes nothing. */
  .put("/mailboxes/:id/members/:memberId", async (c) => {
    const who = requireManager(c);
    return answer(
      c,
      await addMailboxMember(c.var.db, who, c.req.param("id"), c.req.param("memberId")),
    );
  })

  /** Revokes access. Idempotent: removing a member not on the list changes nothing. */
  .delete("/mailboxes/:id/members/:memberId", async (c) => {
    const who = requireManager(c);
    return answer(
      c,
      await removeMailboxMember(c.var.db, who, c.req.param("id"), c.req.param("memberId")),
    );
  });
