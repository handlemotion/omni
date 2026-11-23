import { and, eq, getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  attachments,
  mailboxAccess,
  mailboxes,
  members,
  messages,
  threadState,
  threads,
} from "../schema/index.ts";
import { cleanPreview, type LatestMessage } from "./thread-preview.ts";

/** Whether a `mailbox_access.member_id` is one of the members the reads run as. */
export type IsGrantee = (memberId: AnyColumn | SQL) => SQL;

export interface Participant {
  name: string | null;
  address: string;
}

/**
 * The joins and columns every member read shares. `access` inner-joins `mailbox_access` for the
 * grantees and `members` to require the row's org to be the member's org, so a missing grant or
 * a grant that crosses orgs returns nothing.
 */
export function grantScope(db: Db, isGrantee: IsGrantee) {
  const access = (mailboxId: AnyColumn, orgId: AnyColumn) =>
    [
      [
        mailboxAccess,
        and(eq(mailboxAccess.mailboxId, mailboxId), isGrantee(mailboxAccess.memberId)),
      ],
      [members, and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, orgId))],
    ] as const;
  const [threadGrant, threadOrg] = access(threads.mailboxId, threads.orgId);
  const [messageGrant, messageOrg] = access(messages.mailboxId, messages.orgId);
  const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);

  const legacyDeferredUntil =
    sql<Date | null>`case when ${threadState.snoozedUntil} = 'infinity' then '9999-12-31T00:00:00Z'::timestamptz else ${threadState.snoozedUntil} end`.mapWith(
      threadState.snoozedUntil,
    );
  const threadFields = {
    ...getTableColumns(threads),
    read: sql<boolean>`coalesce(${threadState.read}, false)`.as("read"),
    later: sql<boolean>`coalesce(${threadState.snoozedUntil} > now(), false)`.as("later"),
    deferredUntil: legacyDeferredUntil.as("deferred_until"),
    done: sql<boolean>`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`.as(
      "done",
    ),
  };
  const myState = and(
    eq(threadState.threadId, threads.id),
    eq(threadState.memberId, mailboxAccess.memberId),
  );
  const rowFields = {
    ...threadFields,
    latest:
      sql<LatestMessage | null>`(select jsonb_build_object('subject', m.subject, 'fromName', m.from_name, 'fromAddress', m.from_address, 'snippet', ${cleanPreview(200, 1500)}) from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1)`.as(
        "latest",
      ),
    messageCount:
      sql<number>`(select count(*)::int from ${messages} m where m.thread_id = ${threads.id})`.as(
        "message_count",
      ),
    hasAttachments:
      sql<boolean>`exists (select 1 from ${attachments} a join ${messages} m on m.id = a.message_id where m.thread_id = ${threads.id})`.as(
        "has_attachments",
      ),
    participants: sql<
      Participant[]
    >`(select coalesce(jsonb_agg(jsonb_build_object('name', p.from_name, 'address', p.from_address) order by p.first_at), '[]'::jsonb) from (select distinct on (lower(m.from_address)) m.from_name, m.from_address, m.sent_at as first_at from ${messages} m where m.thread_id = ${threads.id} order by lower(m.from_address), m.sent_at) p)`.as(
      "participants",
    ),
  };

  return {
    db,
    isGrantee,
    access,
    threadGrant,
    threadOrg,
    messageGrant,
    messageOrg,
    mailboxGrant,
    mailboxOrg,
    legacyDeferredUntil,
    threadFields,
    myState,
    rowFields,
  };
}

export type GrantScope = ReturnType<typeof grantScope>;

/** The mailbox matching `where` when the grantees can see it, else null. */
export async function visibleMailbox(
  { db, mailboxGrant, mailboxOrg }: GrantScope,
  where: SQL | undefined,
) {
  const [row] = await db
    .select({ id: mailboxes.id, address: mailboxes.address, autoAssign: mailboxes.autoAssign })
    .from(mailboxes)
    .innerJoin(...mailboxGrant)
    .innerJoin(...mailboxOrg)
    .where(where)
    .limit(1);
  return row ?? null;
}
