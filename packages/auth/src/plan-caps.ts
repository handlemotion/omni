import { FREE_WORKSPACES_PER_OWNER, PLAN_LIMITS } from "@omni/contracts";
import { capUsage, freeWorkspacesOwnedBy, schema, workspacePlan, type Db } from "@omni/db";
import { APIError } from "better-auth/api";
import { count, eq } from "drizzle-orm";

function refuse(message: string) {
  return new APIError("FORBIDDEN", { code: "PLAN_LIMIT", message });
}

async function roomForMember(db: Db, orgId: string, held: number) {
  const plan = await workspacePlan(db, orgId);
  const max = PLAN_LIMITS[plan].members;
  if (held + 1 > max) {
    throw refuse(`this workspace's plan holds ${max} members; move to a bigger plan for more`);
  }
}

/**
 * The organization hooks that hold a workspace to its plan's members (members plus invitations
 * still open) and a person to `FREE_WORKSPACES_PER_OWNER` Free workspaces. Only with billing on.
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
    beforeCreateOrganization: async ({ user }: { user: { id: string } }) => {
      if ((await freeWorkspacesOwnedBy(db, user.id)) >= FREE_WORKSPACES_PER_OWNER) {
        throw refuse(
          `you own ${FREE_WORKSPACES_PER_OWNER} workspaces on the Free plan; move one to a paid plan to make another`,
        );
      }
    },
  };
}
