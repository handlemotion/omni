// A Personal space (ADR 0024) is one person's: Better Auth's organization endpoints must not
// invite anyone to it, add a member, make a team in it, or delete it. `@omni/db` refuses domains
// and shared mailboxes there itself.
import { type Db, ensurePersonalSpace, workspaceKind } from "@omni/db";
import { APIError } from "better-auth/api";
import { endScopedSessions } from "./session-scope.ts";

async function refuseInPersonalSpace(db: Db, orgId: string, what: string) {
  if ((await workspaceKind(db, orgId)) === "personal") {
    throw new APIError("FORBIDDEN", {
      code: "PERSONAL_SPACE",
      message: `a Personal space cannot have ${what}`,
    });
  }
}

/** The organization hooks that keep a Personal space to its one owner. */
export function personalSpaceHooks(db: Db) {
  return {
    beforeCreateInvitation: async ({ invitation }: { invitation: { organizationId: string } }) =>
      refuseInPersonalSpace(db, invitation.organizationId, "invitations"),
    beforeAddMember: async ({ member }: { member: { organizationId: string } }) =>
      refuseInPersonalSpace(db, member.organizationId, "other members"),
    beforeCreateTeam: async ({ team }: { team: { organizationId: string } }) =>
      refuseInPersonalSpace(db, team.organizationId, "teams"),
    beforeDeleteOrganization: async ({ organization }: { organization: { id: string } }) => {
      if ((await workspaceKind(db, organization.id)) === "personal") {
        throw new APIError("FORBIDDEN", {
          code: "PERSONAL_SPACE",
          message: "a Personal space is deleted with its person, not on its own",
        });
      }
      // Sessions scoped to it end first, or they would outlive their scope unscoped (ADR 0024).
      await endScopedSessions(db, organization.id);
    },
  };
}

/**
 * `ensurePersonalSpace` for sign-up and sign-in. A failure is logged, never thrown: a Personal
 * space is made again at the next sign-in, and it must never stop anyone signing in.
 */
export async function ensurePersonalSpaceQuietly(db: Db, userId: string) {
  try {
    await ensurePersonalSpace(db, userId);
  } catch (error) {
    console.error("personal_space.ensure_failed", { userId, error });
  }
}
