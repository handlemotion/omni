import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { ensurePersonalSpace } from "../personal-space.ts";
import {
  drafts,
  mailActions,
  mailboxAccess,
  mailboxes,
  mailboxFolders,
  mailDomains,
  members,
  messages,
  personalSpaces,
  threads,
  threadState,
} from "../schema/index.ts";
import { companyForAddress } from "../session-scopes.ts";

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
export const placeForAddress: (
  db: Db,
  input: { userId: string; address: string; scopeOrgId?: string | null },
) => Promise<Placement> = async (db, input) => {
  const company = await companyForAddress(db, input.address);
  if (input.scopeOrgId && company !== input.scopeOrgId) {
    return { ok: false, reason: "outside_scope", orgId: company ?? input.scopeOrgId };
  }
  const orgId = company ?? (await ensurePersonalSpace(db, input.userId));
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.userId, input.userId)));
  if (!member) return { ok: false, reason: "not_a_member", orgId };
  return { ok: true, orgId, memberId: member.id, kind: company ? "company" : "personal" };
};

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
 * Mailboxes in the wrong workspace, both ways:
 * - Personal-space mailboxes that belong to a company now: their domain, or a parent of it, is
 *   locked by a company their owner (the mailbox's, not the space's) is a member of. The
 *   closest lock wins. A mailbox whose owner is not a member there stays until they join.
 * - A company's Gmail account on an address no company has locked: its owner's Personal space.
 *   An owner who has no Personal space yet gets one from `ensureSpacesForOwnGmail` first.
 */
export async function listMisplacedMailboxes(db: Db) {
  await ensureSpacesForOwnGmail(db);
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
    join ${mailboxAccess} oa on oa.mailbox_id = m.id and oa.role = 'owner'
    join ${members} om on om.id = oa.member_id and om.organization_id = m.org_id
    join ${members} cm on cm.organization_id = c.org_id and cm.user_id = om.user_id
    union all
    -- A company's Gmail account whose address no company has locked (gmail.com, an unclaimed
    -- domain) is its owner's own: it goes to their Personal space. Gmail only:
    -- an IMAP mailbox added by the CLI may have no claimed domain and still be the company's.
    select m.id, m.org_id, m.address, m.provider, m.credentials_enc,
      ps.org_id as target_org_id, pm.id as target_member_id
    from ${mailboxes} m
    join ${mailboxAccess} a on a.mailbox_id = m.id and a.role = 'owner'
    join ${members} om on om.id = a.member_id and om.organization_id = m.org_id
    join ${personalSpaces} ps on ps.user_id = om.user_id
    join ${members} pm on pm.organization_id = ps.org_id and pm.user_id = om.user_id
    where m.kind = 'personal' and m.provider = 'gmail' and m.status <> 'disabled'
      and not exists (select 1 from ${personalSpaces} p3 where p3.org_id = m.org_id)
      and not exists (
        select 1 from ${mailDomains} d
        where (
          lower(split_part(m.address, '@', 2)) = d.domain
          or lower(split_part(m.address, '@', 2)) like '%.' || d.domain
        )
        and not exists (select 1 from ${personalSpaces} p4 where p4.org_id = d.org_id)
      )`)) as unknown as {
    id: string;
    org_id: string;
    address: string;
    provider: MisplacedMailbox["provider"];
    credentials_enc: string;
    target_org_id: string;
    target_member_id: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    address: row.address,
    provider: row.provider,
    credentialsEnc: row.credentials_enc,
    targetOrgId: row.target_org_id,
    targetMemberId: row.target_member_id,
  })) satisfies MisplacedMailbox[];
}

/**
 * Whether `mailboxId` holds work only Postgres has: a draft (drafts are not mirrored to the
 * provider) or an outbox action not finished yet. Moving it would delete them.
 */
export async function hasUnsyncedWork(db: Db, mailboxId: string) {
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

/**
 * Whether every folder of `mailboxId` has finished importing at least once, and it has at least
 * one. `synced_at` is not enough: a folder's first position (UIDNEXT 0) is saved before anything
 * is imported, and a failed import keeps it. Only a completed import stores the server's UIDNEXT,
 * which is at least 1 even for an empty folder.
 */
export async function firstSyncDone(db: Db, mailboxId: string) {
  const [row] = (await db.execute(sql`
    select exists (select 1 from ${mailboxFolders} f where f.mailbox_id = ${mailboxId})
      and not exists (
        select 1 from ${mailboxFolders} f
        where f.mailbox_id = ${mailboxId} and coalesce(f.uidnext, 0) = 0
      ) as done`)) as unknown as { done: boolean }[];
  return row?.done ?? false;
}

/**
 * Copies Omni-only thread state (read, deferred, done; kept nowhere else) from one
 * copy of a mailbox to another, for `toMemberId`. A thread matches by the provider's thread id
 * or by a message both copies hold. Merged into whatever the new copy's sync already wrote: read
 * if either says so, the later done mark, the new copy's deferral if it has one. Merging is
 * idempotent, so a run that repeats changes nothing. Answers how many threads it touched.
 */
export async function carryThreadState(
  db: Db,
  input: { fromMailboxId: string; toMailboxId: string; toOrgId: string; toMemberId: string },
) {
  const rows = (await db.execute(sql`
    insert into ${threadState} (org_id, thread_id, member_id, read, snoozed_until, done_through)
    select distinct on (nt.id)
      ${input.toOrgId}, nt.id, ${input.toMemberId}, s.read, s.snoozed_until, s.done_through
    from ${threadState} s
    join ${threads} ot on ot.id = s.thread_id and ot.mailbox_id = ${input.fromMailboxId}
    join ${threads} nt on nt.mailbox_id = ${input.toMailboxId} and (
      (ot.provider_thread_id is not null and nt.provider_thread_id = ot.provider_thread_id)
      or exists (
        select 1 from ${messages} om
        join ${messages} nm
          on nm.message_id_header = om.message_id_header and nm.mailbox_id = ${input.toMailboxId}
        where om.thread_id = ot.id and nm.thread_id = nt.id
      )
    )
    order by nt.id, s.updated_at desc
    on conflict (thread_id, member_id) do update set
      read = ${threadState}.read or excluded.read,
      done_through = greatest(${threadState}.done_through, excluded.done_through),
      snoozed_until = coalesce(${threadState}.snoozed_until, excluded.snoozed_until)
    returning thread_id`)) as unknown as { thread_id: string }[];
  return rows.length;
}

async function ensureSpacesForOwnGmail(db: Db) {
  const rows = (await db.execute(sql`
    select distinct om.user_id
    from ${mailboxes} m
    join ${mailboxAccess} a on a.mailbox_id = m.id and a.role = 'owner'
    join ${members} om on om.id = a.member_id and om.organization_id = m.org_id
    where m.kind = 'personal' and m.provider = 'gmail' and m.status <> 'disabled'
      and not exists (select 1 from ${personalSpaces} p1 where p1.org_id = m.org_id)
      and not exists (select 1 from ${personalSpaces} p2 where p2.user_id = om.user_id)
      and not exists (
        select 1 from ${mailDomains} d
        where (
          lower(split_part(m.address, '@', 2)) = d.domain
          or lower(split_part(m.address, '@', 2)) like '%.' || d.domain
        )
        and not exists (select 1 from ${personalSpaces} p3 where p3.org_id = d.org_id)
      )`)) as unknown as { user_id: string }[];
  for (const row of rows) await ensurePersonalSpace(db, row.user_id);
}
