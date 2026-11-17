import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import {
  jwks,
  members,
  oauthClientResources,
  oauthClients,
  oauthResources,
} from "./schema/auth.ts";
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
) {
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
 * grant is refused. `ignorePick`: a grant that never offers the pick (desktop sync) reaches what
 * the session reaches, whatever an agent's consent recorded in it before.
 */
export async function oauthWorkspaceReference(
  db: Db,
  input: { sessionId: string; userId: string; ignorePick?: boolean },
) {
  const access = await sessionAccess(db, input.sessionId);
  if (!access) return null;
  if (access.scopeOrgId) return access.scopeOrgId;
  if (input.ignorePick) return ALL_WORKSPACES;
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

const SIGNING_KEY_GRACE = "30 days";

/**
 * The public keys agents' access tokens are signed with (ADR 0029), as Better Auth's JWKS
 * endpoint shapes them. Read here rather than through that endpoint for two reasons:
 *
 * - Hyperdrive caches reads for up to a minute, and a cached empty read made the endpoint report
 *   no keys (and mint another) while tokens were already signed with one: every call was refused.
 *   `now()` in the query keeps Hyperdrive from caching it.
 * - Checking a token never creates a key.
 */
export async function tokenSigningKeys(db: Db) {
  const rows = await db
    .select({
      id: jwks.id,
      publicKey: jwks.publicKey,
      alg: jwks.alg,
      crv: jwks.crv,
    })
    .from(jwks)
    .where(
      sql`${jwks.expiresAt} is null or ${jwks.expiresAt} + ${SIGNING_KEY_GRACE}::interval > now()`,
    );
  return rows.map((row) => ({
    alg: row.alg ?? "EdDSA",
    ...(row.crv ? { crv: row.crv } : {}),
    ...(JSON.parse(row.publicKey) as Record<string, unknown>),
    kid: row.id,
  }));
}

/** A first-party public client, as the server's own config defines it (ADR 0043). */
export interface FirstPartyOAuthClient {
  clientId: string;
  name: string;
  redirectUri: string;
  scopes: string[];
  /** The one resource its tokens are for, and the scopes that resource accepts. */
  resource: { identifier: string; name: string; allowedScopes: string[] };
}

/**
 * Makes sure a first-party client exists as configured: a native public client (PKCE, no
 * secret) that skips the consent screen, linked to its one resource. Rows are config, not
 * user data: run again it changes nothing, and a changed config overwrites the client's row.
 */
export async function ensureFirstPartyOAuthClient(db: Db, client: FirstPartyOAuthClient) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(oauthResources)
      .values({
        id: uuidv7(),
        identifier: client.resource.identifier,
        name: client.resource.name,
        allowedScopes: client.resource.allowedScopes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: oauthResources.identifier });
    const fields = {
      name: client.name,
      redirectUris: [client.redirectUri],
      scopes: client.scopes,
      skipConsent: true,
      disabled: false,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      applicationType: "native",
      requirePKCE: true,
      updatedAt: now,
    };
    await tx
      .insert(oauthClients)
      .values({ id: uuidv7(), clientId: client.clientId, createdAt: now, ...fields })
      .onConflictDoUpdate({ target: oauthClients.clientId, set: fields });
    await tx
      .insert(oauthClientResources)
      .values({
        id: uuidv7(),
        clientId: client.clientId,
        resourceId: client.resource.identifier,
        createdAt: now,
      })
      .onConflictDoNothing();
  });
}
