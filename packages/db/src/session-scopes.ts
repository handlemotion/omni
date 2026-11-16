// A login opens only the workspace it belongs to (ADR 0024 decision 3). A session opened with an
// address on a company's locked domain is scoped to that company: `forUser`, the default member
// and the workspace list see only it. A session with no `session_scopes` row is unscoped.
import { desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { isCompany } from "./personal-space.ts";
import { sessions } from "./schema/auth.ts";
import { sessionScopes } from "./schema/identity.ts";
import { mailDomains } from "./schema/domains.ts";

/**
 * The company whose locked domain `address` is on, or null. A lock on a parent counts
 * (`acme.com` covers `ana@mail.acme.com`), the closest lock winning; free-mail domains are never
 * locked, since nobody can publish a challenge on them (ADR 0010).
 */
export async function companyForAddress(db: Db, address: string): Promise<string | null> {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "");
  if (!domain) return null;
  const [lock] = await db
    .select({ orgId: mailDomains.orgId })
    .from(mailDomains)
    .where(
      sql`${or(
        eq(mailDomains.domain, domain),
        sql`${domain} like '%.' || ${mailDomains.domain}`,
      )} and ${isCompany(db, mailDomains.orgId)}`,
    )
    .orderBy(desc(sql`length(${mailDomains.domain})`))
    .limit(1);
  return lock?.orgId ?? null;
}

/** Records that `sessionId` reaches only `orgId`. Idempotent: the first scope stands. */
export async function scopeSession(db: Db, sessionId: string, orgId: string) {
  await db
    .insert(sessionScopes)
    .values({ sessionId, orgId })
    .onConflictDoNothing({ target: sessionScopes.sessionId });
}

/**
 * What `sessionId` may reach: `{ scopeOrgId }`, null when it is unscoped. Answers null for the
 * whole result when the session no longer exists: Better Auth's signed cookie cache keeps a
 * deleted session readable for a while, and with its scope row gone it would read as unscoped.
 */
export async function sessionAccess(
  db: Db,
  sessionId: string,
): Promise<{ scopeOrgId: string | null } | null> {
  const [row] = await db
    .select({ id: sessions.id, scopeOrgId: sessionScopes.orgId })
    .from(sessions)
    .leftJoin(sessionScopes, eq(sessionScopes.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId));
  return row ? { scopeOrgId: row.scopeOrgId } : null;
}
