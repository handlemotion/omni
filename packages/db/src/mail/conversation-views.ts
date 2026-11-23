import { and, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  mailboxAccess,
  mailboxes,
  members,
  slaDueAt,
  tags,
  threadState,
  threadTags,
  threads,
} from "../schema/index.ts";
import type { GrantScope } from "./grants.ts";
import { withLatest } from "./thread-preview.ts";

/**
 * A shared inbox's helpdesk views, read from the conversation columns on `threads`:
 *
 * - `unassigned`: open, nobody owns it.
 * - `mine`: the member's, open or pending.
 * - `open`, `pending`, `snoozed`, `resolved`: by status.
 * - `sla_at_risk`: open with an SLA due within `SLA_AT_RISK_MINUTES` or already past, soonest
 *   first (every other view is newest first).
 * - `all`: every conversation, for a tag filter on its own.
 */
export const CONVERSATION_VIEWS = [
  "unassigned",
  "mine",
  "open",
  "pending",
  "snoozed",
  "resolved",
  "sla_at_risk",
  "all",
] as const;
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];

/** How close to its due time an open conversation counts as at risk. */
export const SLA_AT_RISK_MINUTES = 30;

/**
 * Keyset position: `at` is `last_message_at`, or the SLA due time in `sla_at_risk`, as an ISO
 * string with Postgres's full microsecond precision (a `Date` drops it, and the page boundary row
 * would then come back on the next page).
 */
export interface ConversationCursor {
  at: string;
  id: string;
}

/** Formats a timestamp as a `ConversationCursor.at`, keeping its microseconds. */
export function cursorAt(at: SQL | AnyColumn) {
  return sql<string>`to_char((${at}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const conversationViewFilter: (view: ConversationView, me: AnyColumn) => SQL | undefined = (
  view,
  me,
) => {
  switch (view) {
    case "unassigned":
      return sql`(${threads.status} = 'open' and ${threads.assigneeMemberId} is null)`;
    case "mine":
      return sql`(${threads.assigneeMemberId} = ${me} and ${threads.status} in ('open', 'pending'))`;
    case "open":
    case "pending":
    case "snoozed":
    case "resolved":
      return sql`${threads.status} = ${view}`;
    case "sla_at_risk":
      return sql`(${threads.status} = 'open' and ${slaDueAt(threads)} <= now() + make_interval(mins => ${SLA_AT_RISK_MINUTES}))`;
    case "all":
      return undefined;
  }
};

const COUNTED_VIEWS = CONVERSATION_VIEWS.filter(
  (v): v is Exclude<ConversationView, "resolved" | "all"> => v !== "resolved" && v !== "all",
);

function conversationPaging(view: ConversationView, after: ConversationCursor | undefined) {
  const due = slaDueAt(threads);
  if (view === "sla_at_risk") {
    return {
      at: due,
      order: [sql`${due} asc`, sql`${threads.id} asc`],
      after: after && sql`(${due}, ${threads.id}) > (${after.at}::timestamptz, ${after.id})`,
    };
  }
  return {
    at: threads.lastMessageAt,
    order: [desc(threads.lastMessageAt), desc(threads.id)],
    after:
      after &&
      sql`(${threads.lastMessageAt}, ${threads.id}) < (${after.at}::timestamptz, ${after.id})`,
  };
}

/** A shared inbox's helpdesk lists and the counts beside them. */
export function conversationViewQueries({
  db,
  isGrantee,
  threadGrant,
  threadOrg,
  myState,
  rowFields,
}: GrantScope) {
  return {
    async listConversations(options: {
      mailboxId: string;
      view: ConversationView;
      tagId?: string;
      after?: ConversationCursor;
      limit?: number;
    }) {
      const { mailboxId, view, tagId, limit = 50 } = options;
      const due = slaDueAt(threads);
      const paging = conversationPaging(view, options.after);
      const page = db
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.mailboxId, mailboxAccess.mailboxId),
            eq(threads.orgId, members.organizationId),
            conversationViewFilter(view, mailboxAccess.memberId),
            tagId
              ? sql`exists (select 1 from ${threadTags} tt where tt.thread_id = ${threads.id} and tt.tag_id = ${tagId})`
              : undefined,
            paging.after,
          ),
        )
        .orderBy(...paging.order)
        .limit(limit)
        .as("threads");
      const rows = await db
        .select({
          ...rowFields,
          slaDueAt: sql<Date | null>`${due}`.mapWith(threads.lastMessageAt).as("sla_due_at"),
          pageAt: cursorAt(paging.at).as("page_at"),
          tags: sql<
            { id: string; name: string; color: string | null }[]
          >`(select coalesce(jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color) order by lower(tg.name)), '[]'::jsonb) from ${threadTags} tt join ${tags} tg on tg.id = tt.tag_id where tt.thread_id = ${threads.id})`.as(
            "tags",
          ),
        })
        .from(mailboxAccess)
        .innerJoin(members, eq(members.id, mailboxAccess.memberId))
        .innerJoin(
          mailboxes,
          and(eq(mailboxes.id, mailboxAccess.mailboxId), eq(mailboxes.kind, "shared")),
        )
        .crossJoinLateral(page)
        .leftJoin(threadState, myState)
        .where(and(isGrantee(mailboxAccess.memberId), eq(mailboxAccess.mailboxId, mailboxId)))
        .orderBy(...paging.order);
      return rows.map((row) => ({ ...withLatest(row), unread: !row.read }));
    },

    async conversationCounts(options: { mailboxId?: string } = {}) {
      const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;
      const inMailbox = options.mailboxId ? eq(threads.mailboxId, options.mailboxId) : undefined;
      const [rows, tagRows] = await Promise.all([
        db
          .select({
            orgId: threads.orgId,
            mailboxId: threads.mailboxId,
            views: sql<
              Record<(typeof COUNTED_VIEWS)[number], number>
            >`jsonb_build_object(${sql.join(
              COUNTED_VIEWS.map(
                (v) =>
                  sql`${v}::text, ${count(conversationViewFilter(v, mailboxAccess.memberId) ?? sql`true`)}`,
              ),
              sql`, `,
            )})`,
          })
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .where(and(eq(mailboxes.kind, "shared"), sql`${threads.status} <> 'resolved'`, inMailbox))
          .groupBy(threads.orgId, threads.mailboxId),
        db
          .select({
            mailboxId: threads.mailboxId,
            tagId: threadTags.tagId,
            count: sql<number>`count(*)::int`,
          })
          .from(threadTags)
          .innerJoin(threads, eq(threads.id, threadTags.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(and(sql`${threads.status} in ('open', 'pending')`, inMailbox))
          .groupBy(threads.mailboxId, threadTags.tagId),
      ]);
      return rows.map((row) => ({
        ...row,
        tags: Object.fromEntries(
          tagRows.filter((t) => t.mailboxId === row.mailboxId).map((t) => [t.tagId, t.count]),
        ),
      }));
    },
  };
}
