import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  conversationEvents,
  mailboxFolders,
  mailboxes,
  messageLocations,
  messages,
  threadTags,
  threads,
} from "../schema/index.ts";
import { visibleMailbox, type GrantScope } from "./grants.ts";

interface Timing {
  count: number;
  median: number | null;
  p90: number | null;
}

function timingOf(rows: unknown) {
  const row = (rows as unknown as Timing[])[0]!;
  const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));
  return { count: row.count, median: round(row.median), p90: round(row.p90) } satisfies Timing;
}

function reportQueries(
  db: Db,
  mailbox: { id: string; address: string },
  range: { from: Date; to: Date },
) {
  const mailboxId = mailbox.id;
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const customer = (alias: string) => {
    const m = sql.raw(alias);
    return sql`${m}.automated = false and lower(${m}.from_address) <> lower(${mailbox.address})
      and not exists (
        select 1 from ${messageLocations} l
        join ${mailboxFolders} f on f.id = l.folder_id
        where l.message_id = ${m}.id and f.role = 'sent'
      )`;
  };
  const fresh = sql`fresh as (
    select distinct m.thread_id from ${messages} m
    where m.mailbox_id = ${mailboxId}
      and m.sent_at >= ${from}::timestamptz and m.sent_at < ${to}::timestamptz
      and ${customer("m")}
      and not exists (
        select 1 from ${messages} p
        where p.thread_id = m.thread_id and p.sent_at < m.sent_at and ${customer("p")}
      )
  )`;
  const asked = sql`(select min(m.sent_at) from ${messages} m
    where m.thread_id = e.thread_id and ${customer("m")})`;
  const timing = (kind: string, extra: SQL, at: SQL) => sql`
    select count(*)::int as count,
      percentile_cont(0.5) within group (order by secs) as median,
      percentile_cont(0.9) within group (order by secs) as p90
    from (
      select greatest(0, extract(epoch from (${at} - ${asked}))) as secs
      from ${conversationEvents} e
      where e.mailbox_id = ${mailboxId} and e.kind = ${kind}
        and ${at} >= ${from}::timestamptz and ${at} < ${to}::timestamptz
        and ${extra}
        -- greatest() skips a null and would count 0s: no customer message, no sample.
        and ${asked} is not null
    ) t`;
  return [
    db.execute(sql`
      with ${fresh}
      select count(*)::int as count from fresh`),
    db.execute(sql`
      with ${fresh}
      select t.assignee_member_id as "memberId", count(*)::int as count
      from fresh f join ${threads} t on t.id = f.thread_id
      group by t.assignee_member_id order by count(*) desc, t.assignee_member_id`),
    db.execute(sql`
      with ${fresh}
      select tt.tag_id as "tagId", count(*)::int as count
      from fresh f join ${threadTags} tt on tt.thread_id = f.thread_id
      group by tt.tag_id order by count(*) desc, tt.tag_id`),
    db.execute(timing("first_response", sql`true`, sql`(e.data->>'at')::timestamptz`)),
    db.execute(timing("status", sql`e.data->>'to' = 'resolved'`, sql`e.created_at`)),
    db.execute(sql`
      select e.actor_member_id as "memberId", count(*)::int as count
      from ${conversationEvents} e
      where e.mailbox_id = ${mailboxId} and e.kind = 'status' and e.data->>'to' = 'resolved'
        and e.created_at >= ${from}::timestamptz and e.created_at < ${to}::timestamptz
      group by e.actor_member_id order by count(*) desc, e.actor_member_id`),
  ] as const;
}

/** A shared inbox's report: new conversations, response and resolution times. */
export function inboxReportQueries(scope: GrantScope) {
  return {
    async inboxReport(mailboxId: string, range: { from: Date; to: Date }) {
      const mailbox = await visibleMailbox(
        scope,
        and(eq(mailboxes.id, mailboxId), eq(mailboxes.kind, "shared")),
      );
      if (!mailbox) return null;
      const [created, byAssignee, byTag, firstResponse, resolved, resolvedBy] = await Promise.all(
        reportQueries(scope.db, mailbox, range),
      );
      return {
        created: {
          count: (created as unknown as { count: number }[])[0]!.count,
          byAssignee: byAssignee as unknown as { memberId: string | null; count: number }[],
          byTag: byTag as unknown as { tagId: string; count: number }[],
        },
        firstResponse: timingOf(firstResponse),
        resolved: {
          ...timingOf(resolved),
          byMember: resolvedBy as unknown as { memberId: string | null; count: number }[],
        },
      };
    },
  };
}
