// Who can see a shared mailbox (ADR 0008). Its Better Auth team is the list; adding or removing
// a member here changes the team and the derived `mailbox_access` grants in one transaction.
// Org owners and admins manage the list; anyone who can see the mailbox can read it. Owners and
// admins also list every mailbox of the workspace (`/workspace/mailboxes`), without its mail.
import {
  addMailboxMember,
  listMailboxMembers,
  listWorkspaceMailboxes,
  removeMailboxMember,
  type MailboxMembersActor,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { canManage } from "../inbox-admin.ts";
import { answerMembership, keepLastInbox } from "./workspace-admin.ts";
import { removeInbox } from "./workspace-inboxes.ts";

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

export const mailboxMembers = new Hono<AppEnv>()
  /**
   * Every mailbox of the active workspace, for owners and admins: address, kind, sync health,
   * the owner of a personal one and how many people see a shared one. Never its mail, and it
   * grants nothing: seeing that a member's inbox exists is not access to it.
   */
  .get("/workspace/mailboxes", async (c) => {
    requireManager(c);
    return c.json({ mailboxes: await listWorkspaceMailboxes(c.var.db, c.var.member.orgId) });
  })

  /** The shared mailbox's members, oldest first. 404 for a personal mailbox. */
  .get("/mailboxes/:id/members", async (c) => {
    const members = await listMailboxMembers(c.var.db, actor(c), c.req.param("id"));
    if (!members) throw new HTTPException(404, { message: "not found" });
    return c.json({ members });
  })

  /** Grants access. Idempotent: adding a member already on the list changes nothing. */
  .put("/mailboxes/:id/members/:memberId", async (c) => {
    const who = requireManager(c);
    return answerMembership(
      c,
      await addMailboxMember(c.var.db, who, c.req.param("id"), c.req.param("memberId")),
    );
  })

  /**
   * Revokes access, unless it is the only inbox they can open (ADR 0026). Idempotent: removing
   * a member not on the list changes nothing.
   */
  .delete("/mailboxes/:id/members/:memberId", async (c) => {
    const who = requireManager(c);
    await keepLastInbox(c, c.req.param("id"), c.req.param("memberId"));
    return answerMembership(
      c,
      await removeMailboxMember(c.var.db, who, c.req.param("id"), c.req.param("memberId")),
    );
  })

  /**
   * Removes an Omni-hosted mailbox from the workspace, for owners and admins: no longer synced,
   * its app password revoked. The mailbox and its mail stay at the host; adding the address
   * again reconnects it. 404 for any other kind of mailbox.
   */
  .delete("/workspace/mailboxes/:id/hosted", limitPerMember("provision"), async (c) => {
    requireManager(c);
    return removeInbox(c, c.req.param("id"), true);
  });
