// Inviting someone with their inboxes (ADR 0026): a personal inbox made now and given to them when
// they accept, and the shared inboxes they will be on. Every member sees at least one inbox, so an
// invitation names one or the other. The invitation itself is Better Auth's, so its own accept,
// reject and list endpoints keep working.
import { APIError } from "better-auth/api";
import {
  ensureMailboxTeam,
  listMemberDomains,
  listWorkspaceMailboxes,
  reserveInvitationInbox,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { logInboxAction, requireCompanyManager } from "../inbox-admin.ts";
import { mailboxPlacement, provisionMailbox } from "../provision-mailbox.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

const invitationBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["member", "admin"]).default("member"),
  /** A personal inbox to make now and give them on accepting. */
  inbox: mailboxPlacement.optional(),
  /** Shared inboxes of this workspace they will be on. */
  sharedInboxIds: z.array(z.string().min(1)).max(100).default([]),
});

/**
 * Whether this workspace can give a new member an inbox with the invitation: a shared inbox to
 * put them on, or a domain on Omni's host to make theirs on. A company whose mail stays at Google,
 * or on its own mail host, has neither until its people connect their own (ADR 0024), so its
 * invitations need no inbox.
 */
async function canGiveInbox(c: Context<AppEnv>, shared: unknown[]) {
  if (shared.length > 0) return true;
  const domains = await listMemberDomains(c.var.db, c.var.member.id);
  return domains.some((d) => d.lock?.provider === "purelymail" && d.lock.addedAt);
}

export const workspaceInvitations = new Hono<AppEnv>()
  .use("/workspace/invitations", requireCompanyManager)

  /**
   * Invites `email` with an inbox. 422 without `inbox` or `sharedInboxIds` when the workspace
   * could give one; 404 for a shared inbox
   * that is not this workspace's; 409 when the address is already someone's. A retry reuses the
   * inbox made the first time (it waits, unowned, until someone accepts).
   */
  .post(
    "/workspace/invitations",
    limitPerMember("provision"),
    zValidator("json", invitationBody),
    async (c) => {
      const { db, member } = c.var;
      const body = c.req.valid("json");
      const shared = (await listWorkspaceMailboxes(db, member.orgId)).filter(
        (m) => m.kind === "shared",
      );
      if (!body.inbox && body.sharedInboxIds.length === 0 && (await canGiveInbox(c, shared))) {
        throw new HTTPException(422, {
          message: "give them an inbox: their own, or a shared one to be on",
        });
      }
      const teamIds: string[] = [];
      for (const id of new Set(body.sharedInboxIds)) {
        if (!shared.some((m) => m.id === id)) {
          throw new HTTPException(404, { message: "no such shared inbox in this workspace" });
        }
        const teamId = await ensureMailboxTeam(db, id);
        if (teamId) teamIds.push(teamId);
      }

      // Made first, so a failed invitation leaves an unowned inbox a retry reuses, never an
      // invitation that promised one and has none.
      const inbox = body.inbox
        ? await provisionMailbox(c, body.inbox, { kind: "personal", ownerMemberId: null })
        : null;

      let invitation;
      try {
        invitation = await c.var.auth.api.createInvitation({
          headers: c.req.raw.headers,
          body: {
            email: body.email,
            role: body.role,
            organizationId: member.orgId,
            ...(teamIds.length > 0 ? { teamId: teamIds } : {}),
          },
        });
      } catch (error) {
        if (error instanceof APIError) {
          throw new HTTPException(error.statusCode as ContentfulStatusCode, {
            message: error.body?.message ?? error.message,
          });
        }
        throw error;
      }

      if (inbox) {
        await reserveInvitationInbox(db, {
          orgId: member.orgId,
          invitationId: invitation.id,
          mailboxId: inbox.mailboxId,
        });
        await logInboxAction(c, "inbox.issued", inbox.address, {
          mailboxId: inbox.mailboxId,
          invitationId: invitation.id,
        });
      }
      return c.json({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: new Date(invitation.expiresAt).toISOString(),
        },
        inbox: inbox ? { mailboxId: inbox.mailboxId, address: inbox.address } : null,
      });
    },
  );
