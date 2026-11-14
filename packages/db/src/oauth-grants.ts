// Which workspaces an agent's OAuth grant reaches (ADR 0029). The consent screen records the
// person's pick for the session; the grant's reference is that workspace's id, or `ALL_WORKSPACES`.
// A session scoped to a company (ADR 0024) can only grant that company.
import { and, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { members } from "./schema/auth.ts";
import { oauthWorkspaceChoices } from "./schema/identity.ts";
import { sessionAccess } from "./session-scopes.ts";

/** The grant reference for every workspace the person belongs to. */
export const ALL_WORKSPACES = "all";

/**
 * Records the workspace `sessionId` picks for its next grant (`null`: every workspace). False
 * when the pick is not one of the user's workspaces, or the session cannot reach it.
 */
export async function chooseOAuthWorkspace(
  db: Db,
  input: { sessionId: string; userId: string; orgId: string | null },
): Promise<boolean> {
  const access = await sessionAccess(db, input.sessionId);
  if (!access) return false;
  if (access.scopeOrgId && input.orgId !== access.scopeOrgId) return false;
  if (input.orgId && !(await isMember(db, input.userId, input.orgId))) return false;
  await db
    .insert(oauthWorkspaceChoices)
    .values({ sessionId: input.sessionId, orgId: input.orgId })
    .onConflictDoUpdate({
      target: oauthWorkspaceChoices.sessionId,
      set: { orgId: input.orgId, createdAt: new Date() },
    });
  return true;
}

/**
 * The reference for a grant made in `sessionId`: its scoped company, else its recorded pick,
 * else every workspace. A pick the user has since lost falls back to nothing: `null`, and the
 * grant is refused.
 */
export async function oauthWorkspaceReference(
  db: Db,
  input: { sessionId: string; userId: string },
): Promise<string | null> {
  const access = await sessionAccess(db, input.sessionId);
  if (!access) return null;
  if (access.scopeOrgId) return access.scopeOrgId;
  const [choice] = await db
    .select({ orgId: oauthWorkspaceChoices.orgId })
    .from(oauthWorkspaceChoices)
    .where(eq(oauthWorkspaceChoices.sessionId, input.sessionId));
  if (!choice?.orgId) return ALL_WORKSPACES;
  return (await isMember(db, input.userId, choice.orgId)) ? choice.orgId : null;
}

async function isMember(db: Db, userId: string, orgId: string) {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  return row !== undefined;
}
