import type { InvitationStatus, PendingInvitation, PendingInvitations } from "@omni/contracts";
import { invitationForUser, listPendingInvitations, type InvitationView } from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveSession, type AppEnv } from "../context.ts";

const wire = (invitation: InvitationView) =>
  ({ ...invitation, expiresAt: invitation.expiresAt.toISOString() }) satisfies PendingInvitation;

async function signedIn(c: Context<AppEnv>) {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  return resolved.user;
}

/**
 * The invitations waiting for the signed-in person, matched against every address they verifiably
 * sign in with. Reading only: joining and declining go through Better Auth's organization
 * endpoints, so `afterAcceptInvitation` claims the reserved inbox and the team mailboxes' access.
 */
export const invitations = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = await signedIn(c);
    const pending = await listPendingInvitations(c.var.db, user.id, user.scopeOrgId);
    return c.json({ invitations: pending.map(wire) } satisfies PendingInvitations);
  })
  .get("/:id", async (c) => {
    const user = await signedIn(c);
    const found = await invitationForUser(c.var.db, user.id, c.req.param("id"));
    if (found.status === "not_found")
      throw new HTTPException(404, { message: "no such invitation" });
    if (found.status === "wrong_account") {
      return c.json({ status: "wrong_account" } satisfies InvitationStatus);
    }
    if (user.scopeOrgId && found.invitation.organization.id !== user.scopeOrgId) {
      return c.json({ status: "wrong_account" } satisfies InvitationStatus);
    }
    return c.json({
      status: found.status,
      invitation: wire(found.invitation),
    } satisfies InvitationStatus);
  });
