import { APIError } from "better-auth/api";
import {
  ensureMailboxTeam,
  listMemberDomains,
  listWorkspaceMailboxes,
  readableOnlyInOmni,
  reserveInvitationInbox,
  schema,
} from "@omni/db";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { logInboxAction, requireCompanyManager } from "../inbox-admin.ts";
import { mailboxPlacement, provisionMailbox } from "../provision-mailbox.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";

const invitationBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["member", "admin", "freelancer"]).default("member"),
  inbox: mailboxPlacement.optional(),
  sharedInboxIds: z.array(z.string().min(1)).max(100).default([]),
});

async function canGiveInbox(c: Context<AppEnv>, shared: unknown[]) {
  if (shared.length > 0) return true;
  const domains = await listMemberDomains(c.var.db, c.var.member.id);
  return domains.some((d) => d.lock?.provider === "purelymail" && d.lock.addedAt);
}

const limitInvites = createMiddleware<AppEnv>(async (c, next) => {
  const wait = await checkRateLimit(c.env, c.var.config, "invite", c.var.user.id);
  if (wait) return tooManyRequests(c, wait, "invite");
  await next();
});

export const workspaceInvitations = new Hono<AppEnv>()
  .use("/workspace/invitations", requireCompanyManager)

  .post("/workspace/invitations", limitInvites, zValidator("json", invitationBody), async (c) => {
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
    if (await readableOnlyInOmni(db, body.email)) {
      throw new HTTPException(422, {
        message: `Omni hosts ${body.email}, so they couldn't open the invitation: invite the email they use today`,
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

    if (body.inbox) {
      const wait = await checkRateLimit(c.env, c.var.config, "provision", member.id);
      if (wait) return tooManyRequests(c, wait, "provision");
    }
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
  })
  .use("/workspace/invitations/*", requireCompanyManager)

  .post("/workspace/invitations/:id/resend", limitInvites, async (c) => {
    const { db, member } = c.var;
    const [invitation] = await db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.id, c.req.param("id")),
          eq(schema.invitations.organizationId, member.orgId),
          eq(schema.invitations.status, "pending"),
        ),
      );
    if (!invitation) throw new HTTPException(404, { message: "no such pending invitation" });
    try {
      await c.var.auth.api.createInvitation({
        headers: c.req.raw.headers,
        body: {
          email: invitation.email,
          role:
            invitation.role === "admin" || invitation.role === "freelancer"
              ? invitation.role
              : "member",
          organizationId: member.orgId,
          resend: true,
          ...(invitation.teamId ? { teamId: invitation.teamId.split(",") } : {}),
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
    return c.json({ ok: true as const });
  });
