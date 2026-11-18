import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxAccess, mailboxes, members } from "../schema/index.ts";

/** A SQL condition: the org whose id is `orgId` (a column or a value) has at least one mailbox. */
export function orgHasMailbox(orgId: SQL | string) {
  return sql`exists (select 1 from ${mailboxes} mb where mb.org_id = ${orgId})`;
}

/** Mailboxes `orgId` has on `domain`. A domain with any cannot be released or moved. */
export async function countMailboxesOnDomain(db: Db, orgId: string, domain: string) {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(eq(mailboxes.orgId, orgId), sql`split_part(${mailboxes.address}, '@', 2) = ${domain}`),
    );
  return rows.length;
}

/** The mailbox at `address` in `orgId`, if any. */
export async function findOrgMailbox(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      status: mailboxes.status,
      credentialsEnc: mailboxes.credentialsEnc,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  return row ?? null;
}

/**
 * Every mailbox `userId`'s members can open, in every org they belong to, personal first and then
 * by address. A grant only counts in the org of the member who holds it.
 */
export function mailboxesOpenTo(db: Db, userId: string) {
  return db
    .select({
      orgId: mailboxes.orgId,
      id: mailboxes.id,
      address: mailboxes.address,
      kind: mailboxes.kind,
      label: mailboxes.label,
      senderName: mailboxes.senderName,
      picture: mailboxes.picture,
    })
    .from(mailboxes)
    .innerJoin(mailboxAccess, eq(mailboxAccess.mailboxId, mailboxes.id))
    .innerJoin(
      members,
      and(
        eq(members.id, mailboxAccess.memberId),
        eq(members.organizationId, mailboxes.orgId),
        eq(members.userId, userId),
      ),
    )
    .orderBy(asc(mailboxes.kind), asc(mailboxes.address));
}

/** Which of `addresses` (lowercase) have a mailbox on Omni's own mail host (ADR 0048). */
export async function omniHostedAddresses(db: Db, addresses: string[]) {
  if (addresses.length === 0) return new Set<string>();
  const rows = await db
    .selectDistinct({ address: sql<string>`lower(${mailboxes.address})` })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.provider, "purelymail"),
        inArray(sql`lower(${mailboxes.address})`, addresses),
      ),
    );
  return new Set(rows.map((row) => row.address));
}
