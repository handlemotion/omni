import { PLAN_LIMITS, TRIAL_PLAN } from "@omni/contracts";
import { capUsage, schema, workspacePlan, type Db } from "@omni/db";
import { APIError } from "better-auth/api";
import { count, eq } from "drizzle-orm";

function refuse(message: string) {
  return new APIError("FORBIDDEN", { code: "PLAN_LIMIT", message });
}

async function roomForMember(db: Db, orgId: string, held: number) {
  const plan = await workspacePlan(db, orgId);
  const max = PLAN_LIMITS[plan ?? TRIAL_PLAN].members;
  if (held + 1 > max) {
    throw refuse(`this workspace's plan holds ${max} members; move to a bigger plan for more`);
  }
}

/**
 * The organization hooks that hold a workspace to its plan's members (members plus invitations
 * still open; a workspace still setting up, before a trial or plan, to the trial plan's). Only
 * with billing on.
 * An invitation is counted when it is sent, so accepting one needs only that the members
 * themselves still fit: a plan moved down meanwhile cannot be passed by old invitations.
 */
export function planCapHooks(db: Db) {
  return {
    beforeCreateInvitation: async ({ invitation }: { invitation: { organizationId: string } }) =>
      roomForMember(
        db,
        invitation.organizationId,
        await capUsage(db, invitation.organizationId, "members"),
      ),
    beforeAddMember: async ({ member }: { member: { organizationId: string } }) =>
      roomForMember(
        db,
        member.organizationId,
        await capUsage(db, member.organizationId, "members"),
      ),
    beforeAcceptInvitation: async ({ invitation }: { invitation: { organizationId: string } }) => {
      const [row] = await db
        .select({ n: count() })
        .from(schema.members)
        .where(eq(schema.members.organizationId, invitation.organizationId));
      await roomForMember(db, invitation.organizationId, row?.n ?? 0);
    },
  };
}
