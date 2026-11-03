// Mail domains (ADR 0007). The Worker records a domain claim after the mail service checked it at
// the provider; the mail service reads claims before it creates mailboxes on a domain.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxes, mailDomains, type MailDomainRecord, members } from "./schema/index.ts";

/** Roles that may set up domains and mailboxes for their org. */
export const DOMAIN_ADMIN_ROLES = ["owner", "admin"] as const;

const domainFields = {
  id: mailDomains.id,
  orgId: mailDomains.orgId,
  domain: mailDomains.domain,
  provider: mailDomains.provider,
  dnsRecords: mailDomains.dnsRecords,
  addedAt: mailDomains.addedAt,
  verifiedAt: mailDomains.verifiedAt,
  checkedAt: mailDomains.checkedAt,
};

export type MailDomain = {
  [K in keyof typeof domainFields]: (typeof mailDomains.$inferSelect)[K];
};

/** The org that claimed `domain`, if any. */
export async function mailDomainOwner(db: Db, domain: string) {
  const [row] = await db
    .select({ orgId: mailDomains.orgId })
    .from(mailDomains)
    .where(eq(mailDomains.domain, domain));
  return row?.orgId ?? null;
}

/**
 * Claims `domain` for `orgId`, or updates the claim with a new check. Returns null when another
 * org holds it (also under a race: the conditional upsert never takes over a claim). Idempotent:
 * `addedAt` keeps its first time, `verifiedAt` keeps the time every record first passed.
 */
export async function saveMailDomain(
  db: Db,
  input: {
    orgId: string;
    domain: string;
    provider: MailDomain["provider"];
    dnsRecords: MailDomainRecord[];
    added: boolean;
    verified: boolean;
  },
): Promise<MailDomain | null> {
  const now = new Date();
  const [row] = await db
    .insert(mailDomains)
    .values({
      orgId: input.orgId,
      domain: input.domain,
      provider: input.provider,
      dnsRecords: input.dnsRecords,
      addedAt: input.added ? now : null,
      verifiedAt: input.verified ? now : null,
      checkedAt: now,
    })
    .onConflictDoUpdate({
      target: mailDomains.domain,
      set: {
        provider: input.provider,
        dnsRecords: input.dnsRecords,
        addedAt: sql`coalesce(${mailDomains.addedAt}, excluded.added_at)`,
        verifiedAt: input.verified
          ? sql`coalesce(${mailDomains.verifiedAt}, excluded.verified_at)`
          : null,
        checkedAt: now,
        updatedAt: now,
      },
      setWhere: eq(mailDomains.orgId, input.orgId),
    })
    .returning(domainFields);
  return row ?? null;
}

/** The member's org's domains, only for owners and admins: others get nothing. */
export async function listMemberDomains(db: Db, memberId: string): Promise<MailDomain[]> {
  return db
    .select(domainFields)
    .from(mailDomains)
    .innerJoin(
      members,
      and(
        eq(members.id, memberId),
        eq(members.organizationId, mailDomains.orgId),
        inArray(members.role, DOMAIN_ADMIN_ROLES),
      ),
    )
    .orderBy(mailDomains.createdAt);
}

/** One domain of the member's org, by id, under the same rule as `listMemberDomains`. */
export async function findMemberDomain(db: Db, memberId: string, domainId: string) {
  const [row] = await db
    .select(domainFields)
    .from(mailDomains)
    .innerJoin(
      members,
      and(
        eq(members.id, memberId),
        eq(members.organizationId, mailDomains.orgId),
        inArray(members.role, DOMAIN_ADMIN_ROLES),
      ),
    )
    .where(eq(mailDomains.id, domainId));
  return row ?? null;
}

// Trusted reads for the mail service, which acts only on what the Worker already authorized.

/** `orgId`'s claim on `domain`, or null if it has none. */
export async function findOrgDomain(db: Db, orgId: string, domain: string) {
  const [row] = await db
    .select(domainFields)
    .from(mailDomains)
    .where(and(eq(mailDomains.orgId, orgId), eq(mailDomains.domain, domain)));
  return row ?? null;
}

/** The mailbox at `address` in `orgId`, if any. */
export async function findOrgMailbox(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      provider: mailboxes.provider,
      status: mailboxes.status,
      credentialsEnc: mailboxes.credentialsEnc,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  return row ?? null;
}
