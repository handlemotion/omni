// Where a mailbox lives (ADR 0024 decision 2): its address decides, not the workspace that happens
// to be open. An address on a company's locked domain belongs to that company; any other address
// belongs to the connecting person's Personal space.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { ensurePersonalSpace } from "./personal-space.ts";
import { mailboxAccess, mailboxes, mailDomains, members, personalSpaces } from "./schema/index.ts";
import { companyForAddress } from "./session-scopes.ts";

export type Placement =
  | { ok: true; orgId: string; memberId: string; kind: "personal" | "company" }
  | {
      ok: false;
      /** The address is a company's and the person is not its member, or is outside the scope. */
      reason: "not_a_member" | "outside_scope";
      orgId: string;
    };

/**
 * The workspace and member `address` goes to when `userId` connects it. With `scopeOrgId` (a
 * session opened with a company's address), only that company may receive it.
 */
export async function placeForAddress(
  db: Db,
  input: { userId: string; address: string; scopeOrgId?: string | null },
): Promise<Placement> {
  const company = await companyForAddress(db, input.address);
  const orgId = company ?? (await ensurePersonalSpace(db, input.userId));
  if (input.scopeOrgId && orgId !== input.scopeOrgId) {
    return { ok: false, reason: "outside_scope", orgId };
  }
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.userId, input.userId)));
  if (!member) return { ok: false, reason: "not_a_member", orgId };
  return { ok: true, orgId, memberId: member.id, kind: company ? "company" : "personal" };
}

/**
 * The Google accounts `userId` has a grant on, in every workspace, or only in `scopeOrgId` for a
 * scoped session: what Settings lists. Disconnecting one still needs its owner grant.
 */
export async function listUserGoogleAccounts(db: Db, userId: string, scopeOrgId?: string | null) {
  return db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      status: mailboxes.status,
      memberId: members.id,
    })
    .from(mailboxes)
    .innerJoin(mailboxAccess, eq(mailboxAccess.mailboxId, mailboxes.id))
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .where(
      and(
        eq(members.userId, userId),
        eq(mailboxes.provider, "gmail"),
        eq(mailboxes.kind, "personal"),
        scopeOrgId ? eq(mailboxes.orgId, scopeOrgId) : sql`true`,
      ),
    )
    .orderBy(asc(mailboxes.address));
}

/** A mailbox in someone's Personal space whose address a company they belong to has since locked. */
export interface MisplacedMailbox {
  id: string;
  orgId: string;
  address: string;
  provider: (typeof mailboxes.$inferSelect)["provider"];
  credentialsEnc: string;
  targetOrgId: string;
  targetMemberId: string;
}

/**
 * Personal-space mailboxes that belong to a company now (ADR 0024 decision 2): their domain, or a
 * parent of it, is locked by a company their owner is a member of. The closest lock wins. A
 * mailbox whose owner is not a member there stays until they join.
 */
export async function listMisplacedMailboxes(db: Db): Promise<MisplacedMailbox[]> {
  const rows = (await db.execute(sql`
    select distinct on (m.id)
      m.id, m.org_id, m.address, m.provider, m.credentials_enc,
      d.org_id as target_org_id, cm.id as target_member_id
    from ${mailboxes} m
    join ${personalSpaces} ps on ps.org_id = m.org_id
    join ${mailDomains} d
      on lower(split_part(m.address, '@', 2)) = d.domain
      or lower(split_part(m.address, '@', 2)) like '%.' || d.domain
    join ${members} cm on cm.organization_id = d.org_id and cm.user_id = ps.user_id
    where m.kind = 'personal' and m.status <> 'disabled'
      and not exists (select 1 from ${personalSpaces} p2 where p2.org_id = d.org_id)
    order by m.id, length(d.domain) desc`)) as unknown as {
    id: string;
    org_id: string;
    address: string;
    provider: MisplacedMailbox["provider"];
    credentials_enc: string;
    target_org_id: string;
    target_member_id: string;
  }[]; // postgres-js: the rows themselves
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    address: row.address,
    provider: row.provider,
    credentialsEnc: row.credentials_enc,
    targetOrgId: row.target_org_id,
    targetMemberId: row.target_member_id,
  }));
}
