// A login opens only the workspace it belongs to (ADR 0024 decision 3). A session opened with an
// address on a company's locked domain is scoped to that company: `forUser`, the default member
// and the workspace list see only it. A session with no `session_scopes` row is unscoped.
import { desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { isCompany } from "./personal-space.ts";
import { sessionScopes } from "./schema/identity.ts";
import { mailDomains } from "./schema/mail.ts";

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

/** The organization `sessionId` is scoped to, or null when it is unscoped. */
export async function sessionScope(db: Db, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: sessionScopes.orgId })
    .from(sessionScopes)
    .where(eq(sessionScopes.sessionId, sessionId));
  return row?.orgId ?? null;
}
