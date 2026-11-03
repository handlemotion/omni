import { and, desc, eq, getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  attachments,
  mailActions,
  mailboxAccess,
  mailboxes,
  members,
  messages,
  threadState,
  threads,
  triageBucket,
} from "./schema/index.ts";

/** Triage at or above this confidence files itself; below it lands in the Unsure lane. */
export const TRIAGE_AUTO_FILE_CONFIDENCE = 0.85;

export type Lane = (typeof triageBucket.enumValues)[number] | "unsure";

export const LANES = [...triageBucket.enumValues, "unsure"] as const satisfies readonly Lane[];

/**
 * Per-member triage views (ADR 0007). A thread is *done* for a member while its
 * `last_message_at` is at or before their `done_through`, and *deferred* while their
 * `snoozed_until` is in the future; done wins over deferred.
 *
 * - `inbox`: not archived, not done, not deferred. What still needs attention.
 * - `queue`: not archived, deferred, not done. Back in the inbox by itself when the time passes.
 * - `done`: done, archived or not.
 * - `archive`: archived (moved out of INBOX on the server; shared by everyone on the mailbox).
 * - `all`: every thread the member can see, whatever its state.
 */
export const THREAD_VIEWS = ["inbox", "queue", "done", "archive", "all"] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];

export interface Participant {
  name: string | null;
  address: string;
}

/** Lane membership, the same rule the list filter and the counts use. */
function laneFilter(lane: Lane): SQL {
  return lane === "unsure"
    ? sql`(${threads.triageSource} = 'ai' and ${threads.triageConfidence} < ${TRIAGE_AUTO_FILE_CONFIDENCE})`
    : sql`(${threads.triage} = ${lane} and (${threads.triageSource} = 'person' or ${threads.triageConfidence} >= ${TRIAGE_AUTO_FILE_CONFIDENCE}))`;
}

export interface ThreadCursor {
  lastMessageAt: Date;
  id: string;
}

export type MemberQueries = ReturnType<typeof forMember>;

const { searchVector: _searchVector, ...messageColumns } = getTableColumns(messages);

/**
 * The only read path to mail data. Every query inner-joins `mailbox_access` for this member and
 * `members` to require the row's org to be the member's org, so a missing grant or a grant that
 * crosses orgs returns nothing.
 */
export function forMember(db: Db, memberId: string) {
  const access = (mailboxId: AnyColumn, orgId: AnyColumn) =>
    [
      [
        mailboxAccess,
        and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.memberId, memberId)),
      ],
      [members, and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, orgId))],
    ] as const;
  const [threadGrant, threadOrg] = access(threads.mailboxId, threads.orgId);
  const [messageGrant, messageOrg] = access(messages.mailboxId, messages.orgId);

  const threadFields = {
    ...getTableColumns(threads),
    read: sql<boolean>`coalesce(${threadState.read}, false)`.as("read"),
    deferredUntil: threadState.snoozedUntil,
    done: sql<boolean>`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`.as(
      "done",
    ),
  };
  const myState = and(eq(threadState.threadId, threads.id), eq(threadState.memberId, memberId));
  // The two rules on this member's state row, applied inside the page scan as one primary-key
  // lookup per thread, so a page never comes back short. `counts` applies the same rules to
  // the joined row.
  const state = (filter: SQL) =>
    sql`exists (select 1 from ${threadState} s where s.thread_id = ${threads.id} and s.member_id = ${memberId} and (${filter}))`;
  const doneRule = sql`${threads.lastMessageAt} <= s.done_through`;
  const deferredRule = sql`s.snoozed_until > now()`;
  const viewFilters: Record<ThreadView, SQL[]> = {
    inbox: [eq(threads.archived, false), sql`not ${state(sql`${doneRule} or ${deferredRule}`)}`],
    queue: [
      eq(threads.archived, false),
      state(sql`${deferredRule} and not coalesce(${doneRule}, false)`),
    ],
    done: [state(doneRule)],
    archive: [eq(threads.archived, true)],
    all: [],
  };

  // Per-thread summary for list rows, read through the thread (already access-checked).
  const rowFields = {
    ...threadFields,
    latest: sql<{
      subject: string;
      fromName: string | null;
      fromAddress: string;
      snippet: string;
    } | null>`(select jsonb_build_object('subject', m.subject, 'fromName', m.from_name, 'fromAddress', m.from_address, 'snippet', left(btrim(regexp_replace(left(m.clean_text, 600), '\\s+', ' ', 'g')), 200)) from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1)`.as(
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
    // Distinct senders in the order they first wrote.
    participants: sql<
      Participant[]
    >`(select coalesce(jsonb_agg(jsonb_build_object('name', p.from_name, 'address', p.from_address) order by p.first_at), '[]'::jsonb) from (select distinct on (lower(m.from_address)) m.from_name, m.from_address, m.sent_at as first_at from ${messages} m where m.thread_id = ${threads.id} order by lower(m.from_address), m.sent_at) p)`.as(
      "participants",
    ),
  };

  return {
    async listThreads(
      options: {
        mailboxId?: string;
        lane?: Lane;
        view?: ThreadView;
        before?: ThreadCursor;
        limit?: number;
      } = {},
    ) {
      const { mailboxId, lane, view = "inbox", before, limit = 50 } = options;
      const filters: (SQL | undefined)[] = [
        eq(threads.mailboxId, mailboxAccess.mailboxId),
        eq(threads.orgId, members.organizationId),
        ...viewFilters[view],
      ];
      if (lane) filters.push(laneFilter(lane));
      if (before) {
        filters.push(
          sql`(${threads.lastMessageAt}, ${threads.id}) < (${before.lastMessageAt.toISOString()}::timestamptz, ${before.id})`,
        );
      }
      // The newest `limit` threads of each granted mailbox (an index range per mailbox), then
      // the newest `limit` of those. Cost follows grants × limit, not the size of the mail. The
      // lateral page is aliased `threads`, so the outer query reads it through the same columns.
      const page = db
        .select()
        .from(threads)
        .where(and(...filters))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(limit)
        .as("threads");
      const rows = await db
        .select(rowFields)
        .from(mailboxAccess)
        .innerJoin(members, eq(members.id, mailboxAccess.memberId))
        .crossJoinLateral(page)
        .leftJoin(threadState, myState)
        .where(
          and(
            eq(mailboxAccess.memberId, memberId),
            mailboxId ? eq(mailboxAccess.mailboxId, mailboxId) : undefined,
          ),
        )
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(limit);
      return rows.map(({ latest, ...row }) => ({
        ...row,
        unread: !row.read,
        subject: latest?.subject ?? "",
        snippet: latest?.snippet ?? "",
        latestFrom: latest ? { name: latest.fromName, address: latest.fromAddress } : null,
      }));
    },

    /**
     * Thread counts per granted mailbox, for the sidebar: inbox (unread too), queue, and each
     * lane within the inbox. The same rules as `listThreads`.
     */
    async counts() {
      // This member's state row is joined already; no per-thread lookup.
      const done = sql`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`;
      const deferred = sql`coalesce(${threadState.snoozedUntil} > now(), false)`;
      const queue = sql`(${deferred} and not ${done})`;
      const inbox = sql`not (${deferred} or ${done})`;
      const unread = sql`coalesce(${threadState.read}, false) = false`;
      const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;
      const rows = await db
        .select({
          mailboxId: threads.mailboxId,
          inbox: count(inbox),
          unread: count(and(inbox, unread)!),
          queue: count(queue),
          lanes: sql<Record<Lane, number>>`jsonb_build_object(${sql.join(
            LANES.map((lane) => sql`${lane}::text, ${count(and(inbox, laneFilter(lane))!)}`),
            sql`, `,
          )})`,
        })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .leftJoin(threadState, myState)
        .where(eq(threads.archived, false))
        .groupBy(threads.mailboxId);
      return rows;
    },

    /** An outbox action this member asked for, on a mailbox they can still see. */
    async getAction(actionId: string) {
      const [actionGrant, actionOrg] = access(mailActions.mailboxId, mailActions.orgId);
      const [row] = await db
        .select({
          id: mailActions.id,
          mailboxId: mailActions.mailboxId,
          kind: mailActions.kind,
          status: mailActions.status,
          attempts: mailActions.attempts,
          error: mailActions.lastError,
          createdAt: mailActions.createdAt,
          completedAt: mailActions.completedAt,
        })
        .from(mailActions)
        .innerJoin(...actionGrant)
        .innerJoin(...actionOrg)
        .where(and(eq(mailActions.id, actionId), eq(mailActions.memberId, memberId)));
      return row ?? null;
    },

    async getThread(threadId: string) {
      // One round trip: the three reads are independent and each carries the access check.
      const [[thread], rows, files] = await Promise.all([
        db
          .select({ ...threadFields, mailboxAddress: mailboxes.address })
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .leftJoin(threadState, myState)
          .where(eq(threads.id, threadId)),
        db
          .select(messageColumns)
          .from(messages)
          .innerJoin(...messageGrant)
          .innerJoin(...messageOrg)
          .where(eq(messages.threadId, threadId))
          .orderBy(messages.sentAt, messages.id),
        db
          .select(getTableColumns(attachments))
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .innerJoin(...messageGrant)
          .innerJoin(...messageOrg)
          .where(eq(messages.threadId, threadId)),
      ]);
      if (!thread) return null;
      return {
        ...thread,
        messages: rows.map((m) => ({
          ...m,
          attachments: files.filter((a) => a.messageId === m.id),
        })),
      };
    },

    /**
     * Full-text search over subject, sender and clean text, newest first. `query` uses web search
     * syntax; `rank` is the match's relevance, for display. Each granted mailbox is searched on
     * its own and the newest hits merged: a common term walks the mailbox's newest messages and
     * stops after `limit` hits, a rare one uses the GIN index. Ranking every hit instead costs a
     * read of every matching message.
     */
    async search(query: string, options: { mailboxId?: string; limit?: number } = {}) {
      const { mailboxId, limit = 20 } = options;
      const tsquery = sql`websearch_to_tsquery('english', ${query})`;
      const hits = db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxAccess.mailboxId),
            eq(messages.orgId, members.organizationId),
            sql`${messages.searchVector} @@ ${tsquery}`,
          ),
        )
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(limit)
        .as("messages");
      return db
        .select({
          messageId: messages.id,
          threadId: messages.threadId,
          mailboxId: messages.mailboxId,
          subject: messages.subject,
          fromName: messages.fromName,
          fromAddress: messages.fromAddress,
          sentAt: messages.sentAt,
          rank: sql<number>`ts_rank(${messages.searchVector}, ${tsquery})`,
        })
        .from(mailboxAccess)
        .innerJoin(members, eq(members.id, mailboxAccess.memberId))
        .crossJoinLateral(hits)
        .where(
          and(
            eq(mailboxAccess.memberId, memberId),
            mailboxId ? eq(mailboxAccess.mailboxId, mailboxId) : undefined,
          ),
        )
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(limit);
    },

    /**
     * Upserts this member's state. Omitted fields keep their value; `null` clears one.
     * `doneThrough` is capped at the thread's `last_message_at`, so it never covers a message
     * that has not arrived yet. Returns the row and whether the thread is done now, or null when
     * the member cannot see the thread.
     */
    async setThreadState(
      threadId: string,
      patch: { read?: boolean; deferredUntil?: Date | null; doneThrough?: Date | null },
    ) {
      const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
      const set: Partial<Record<"read" | "snoozedUntil" | "doneThrough" | "updatedAt", SQL>> = {
        updatedAt: sql`now()`,
      };
      if (patch.read !== undefined) set.read = sql`excluded.read`;
      if (patch.deferredUntil !== undefined) set.snoozedUntil = sql`excluded.snoozed_until`;
      if (patch.doneThrough !== undefined) set.doneThrough = sql`excluded.done_through`;

      const [row] = await db
        .insert(threadState)
        .select(
          db
            .select({
              orgId: threads.orgId,
              threadId: threads.id,
              memberId: mailboxAccess.memberId,
              read: sql`${patch.read ?? false}::boolean`.as("read"),
              snoozedUntil: sql`${iso(patch.deferredUntil)}::timestamptz`.as("snoozed_until"),
              // Not `least(null, x)`: Postgres skips nulls there, which would mark it done.
              doneThrough: (patch.doneThrough
                ? sql`least(${iso(patch.doneThrough)}::timestamptz, ${threads.lastMessageAt})`
                : sql`null::timestamptz`
              ).as("done_through"),
              updatedAt: sql`now()`.as("updated_at"),
            })
            .from(threads)
            .innerJoin(...threadGrant)
            .innerJoin(...threadOrg)
            .where(eq(threads.id, threadId)),
        )
        .onConflictDoUpdate({ target: [threadState.threadId, threadState.memberId], set })
        .returning({
          read: threadState.read,
          deferredUntil: threadState.snoozedUntil,
          doneThrough: threadState.doneThrough,
          done: sql<boolean>`coalesce((select ${threads.lastMessageAt} from ${threads} where ${threads.id} = ${threadState.threadId}) <= ${threadState.doneThrough}, false)`,
        });
      return row ?? null;
    },
  };
}
