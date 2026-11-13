// The workspace admin surface for inboxes (ADR 0026): who is in the company and which inboxes
// each can open, issuing a personal inbox to someone, and shared inboxes with their people. Owners
// and admins of a company only; a member gets 403, a Personal space 404. Nothing here returns mail
// or adds a grant on someone else's personal inbox: seeing that an inbox exists is not access.
import {
  addMailboxMember,
  hasSharedGrant,
  listMailboxMembers,
  listWorkspaceMailboxes,
  listWorkspaceMembers,
  memberInboxCount,
  orgMember,
  removeMailboxMember,
  type MailboxMembersActor,
  type MailboxMembershipResult,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { canManage, logInboxAction, requireCompanyManager } from "../inbox-admin.ts";
import { mailboxPlacement, provisionMailbox } from "../provision-mailbox.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

function manager(c: Context<AppEnv>): MailboxMembersActor {
  const { id, orgId } = c.var.member;
  return { memberId: id, orgId, manage: true };
}

/** The member of the active workspace named in the path, or 404. */
async function pathMember(c: Context<AppEnv>) {
  const member = await orgMember(c.var.db, c.var.member.orgId, c.req.param("memberId") ?? "");
  if (!member) throw new HTTPException(404, { message: "no such member in this workspace" });
  return member;
}

export function answerMembership(c: Context<AppEnv>, result: MailboxMembershipResult) {
  if (result === "mailbox_not_found") throw new HTTPException(404, { message: "not found" });
  if (result === "member_not_found") {
    throw new HTTPException(404, { message: "no such member in this organization" });
  }
  return c.json({ ok: true as const });
}

/**
 * Refuses to take away the last inbox a member can open (ADR 0026: every member sees at least
 * one). Only for a shared inbox of this workspace that they are on; anything else is left to the
 * caller's own checks.
 */
export async function keepLastInbox(c: Context<AppEnv>, mailboxId: string, memberId: string) {
  const { db, member } = c.var;
  if (!(await hasSharedGrant(db, member.orgId, mailboxId, memberId))) return;
  if ((await memberInboxCount(db, member.orgId, memberId)) <= 1) {
    throw new HTTPException(409, {
      message: "this is the only inbox they can open: give them another one first",
    });
  }
}

const sharedInboxBody = mailboxPlacement.extend({
  /** The people who see it; at least one. */
  memberIds: z.array(z.string().min(1)).min(1).max(500),
});

export const workspaceAdmin = new Hono<AppEnv>()
  .use("/workspace/members/*", requireCompanyManager)
  .use("/workspace/members", requireCompanyManager)
  .use("/workspace/inboxes", requireCompanyManager)
  .use("/workspace/shared-inboxes", requireCompanyManager)

  /** Every member, oldest first, with the inboxes each can open. One call for People. */
  .get("/workspace/members", async (c) =>
    c.json({ members: await listWorkspaceMembers(c.var.db, c.var.member.orgId) }),
  )

  /** One member's personal inboxes. */
  .get("/workspace/members/:memberId/inboxes", async (c) => {
    const member = await pathMember(c);
    const everyone = await listWorkspaceMembers(c.var.db, c.var.member.orgId);
    return c.json({ inboxes: everyone.find((m) => m.id === member.id)?.inboxes ?? [] });
  })

  /**
   * Issues a personal inbox to the member: they get the owner grant, the caller none. A member
   * may have several. Idempotent per address; 409 when the address is someone else's or shared.
   */
  .post(
    "/workspace/members/:memberId/inboxes",
    limitPerMember("provision"),
    zValidator("json", mailboxPlacement),
    async (c) => {
      const member = await pathMember(c);
      const result = await provisionMailbox(c, c.req.valid("json"), {
        kind: "personal",
        ownerMemberId: member.id,
      });
      if (result.created) {
        await logInboxAction(c, "inbox.issued", result.address, {
          mailboxId: result.mailboxId,
          memberIds: [member.id],
        });
      }
      return c.json(result);
    },
  )

  /**
   * Every mailbox of the workspace. `orphaned` marks a personal inbox whose owner left: nobody
   * can open it until an owner or admin deals with it.
   */
  .get("/workspace/inboxes", async (c) => {
    const mailboxes = await listWorkspaceMailboxes(c.var.db, c.var.member.orgId);
    return c.json({
      inboxes: mailboxes.map((m) => ({ ...m, orphaned: m.kind === "personal" && !m.owner })),
    });
  })

  /**
   * Creates a shared inbox seen by `memberIds`, who must be members here. Idempotent per address
   * (a retry adds no one twice); 409 when the address is someone's personal inbox.
   */
  .post(
    "/workspace/shared-inboxes",
    limitPerMember("provision"),
    zValidator("json", sharedInboxBody),
    async (c) => {
      const { db, member } = c.var;
      const { memberIds, ...placement } = c.req.valid("json");
      const [first, ...rest] = [...new Set(memberIds)] as [string, ...string[]];
      for (const id of [first, ...rest]) {
        if (!(await orgMember(db, member.orgId, id))) {
          throw new HTTPException(404, { message: "no such member in this workspace" });
        }
      }
      // The first person takes the seat the mail service seeds the team with, so the caller is
      // on it only if they named themselves.
      const result = await provisionMailbox(c, placement, {
        kind: "shared",
        ownerMemberId: first,
      });
      for (const id of rest) {
        await addMailboxMember(db, manager(c), result.mailboxId, id);
      }
      if (result.created) {
        await logInboxAction(c, "shared_inbox.created", result.address, {
          mailboxId: result.mailboxId,
          memberIds: [first, ...rest],
        });
      }
      return c.json(result);
    },
  )

  /**
   * Who sees a shared inbox, oldest first: for owners and admins, and for anyone on it (as the
   * route it replaces allowed). 404 for a personal one, or one the caller cannot see.
   */
  .get("/workspace/shared-inboxes/:id/people", async (c) => {
    const { id, orgId, role } = c.var.member;
    const actor = { memberId: id, orgId, manage: canManage(role) };
    const people = await listMailboxMembers(c.var.db, actor, c.req.param("id"));
    if (!people) throw new HTTPException(404, { message: "not found" });
    return c.json({ people });
  })

  /** Adds someone. Idempotent: adding someone already on it changes nothing. */
  .put("/workspace/shared-inboxes/:id/people/:memberId", requireCompanyManager, async (c) =>
    answerMembership(
      c,
      await addMailboxMember(c.var.db, manager(c), c.req.param("id"), c.req.param("memberId")),
    ),
  )

  /** Removes someone, unless it is the only inbox they can open. Idempotent otherwise. */
  .delete("/workspace/shared-inboxes/:id/people/:memberId", requireCompanyManager, async (c) => {
    const mailboxId = c.req.param("id");
    const memberId = c.req.param("memberId");
    await keepLastInbox(c, mailboxId, memberId);
    return answerMembership(
      c,
      await removeMailboxMember(c.var.db, manager(c), mailboxId, memberId),
    );
  });
