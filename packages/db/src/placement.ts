// Where a mailbox lives (ADR 0024 decision 2): its address decides, not the workspace that happens
// to be open. An address on a company's locked domain belongs to that company; any other address
// belongs to the connecting person's Personal space.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { ensurePersonalSpace } from "./personal-space.ts";
import {
  drafts,
  mailActions,
  mailboxes,
  mailDomains,
  members,
  personalSpaces,
} from "./schema/index.ts";
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
  // The closest company lock on each Personal-space mailbox's domain first, then the owner's
  // membership in that company: a member of a parent's company must not take a subdomain that
  // another company locked.
  const rows = (await db.execute(sql`
    with closest as (
      select distinct on (m.id) m.id as mailbox_id, d.org_id
      from ${mailboxes} m
      join ${personalSpaces} ps on ps.org_id = m.org_id
      join ${mailDomains} d
        on lower(split_part(m.address, '@', 2)) = d.domain
        or lower(split_part(m.address, '@', 2)) like '%.' || d.domain
      where m.kind = 'personal' and m.status <> 'disabled'
        and not exists (select 1 from ${personalSpaces} p2 where p2.org_id = d.org_id)
      order by m.id, length(d.domain) desc
    )
    select m.id, m.org_id, m.address, m.provider, m.credentials_enc,
      c.org_id as target_org_id, cm.id as target_member_id
    from closest c
    join ${mailboxes} m on m.id = c.mailbox_id
    join ${personalSpaces} ps on ps.org_id = m.org_id
    join ${members} cm on cm.organization_id = c.org_id and cm.user_id = ps.user_id`)) as unknown as {
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

/**
 * Whether `mailboxId` holds work only Postgres has: a draft (drafts are not mirrored to the
 * provider) or an outbox action not finished yet. Moving it would delete them.
 */
export async function hasUnsyncedWork(db: Db, mailboxId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select (
      exists (select 1 from ${drafts} d where d.mailbox_id = ${mailboxId})
      or exists (
        select 1 from ${mailActions} a
        where a.mailbox_id = ${mailboxId} and a.status in ('pending', 'running')
      )
    ) as busy`)) as unknown as { busy: boolean }[];
  return row?.busy ?? false;
}
