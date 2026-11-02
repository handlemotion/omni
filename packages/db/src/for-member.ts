import {
  and,
  desc,
  eq,
  getTableColumns,
  notExists,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  type Address,
} from "./schema/index.ts";

/** Triage at or above this confidence files itself; below it lands in the Unsure lane. */
export const TRIAGE_AUTO_FILE_CONFIDENCE = 0.85;

/** Unread counts stop at this many threads (the apps show "999+"), so a count costs at most this. */
export const UNREAD_COUNT_CAP = 1000;

export const LANES = [...triageBucket.enumValues, "unsure"] as const;
export type Lane = (typeof LANES)[number];

/**
 * `inbox`: not archived and not snoozed into the future by this member. `snoozed`: not archived
 * and snoozed into the future by this member. `archive`: archived. Snoozes are per member, so
 * another member's snooze never hides a thread.
 */
export type ThreadView = "inbox" | "snoozed" | "archive";

export interface ThreadCursor {
  lastMessageAt: Date;
  id: string;
}

export type MemberQueries = ReturnType<typeof forMember>;

const { searchVector: _searchVector, ...messageColumns } = getTableColumns(messages);

/** Characters of the latest message's clean text in a list row's snippet. */
const SNIPPET_LENGTH = 160;
/** Senders a list row names. */
const MAX_PARTICIPANTS = 5;

/** Lane membership as a filter on `threads`. */
function laneFilter(lane: Lane): SQL | undefined {
  if (lane === "unsure") {
    return and(
      eq(threads.triageSource, "ai"),
      sql`${threads.triageConfidence} < ${TRIAGE_AUTO_FILE_CONFIDENCE}`,
    );
  }
  return and(
    eq(threads.triage, lane),
    or(
      eq(threads.triageSource, "person"),
      sql`${threads.triageConfidence} >= ${TRIAGE_AUTO_FILE_CONFIDENCE}`,
    ),
  );
}

/** postgres-js parses `json` itself; this also accepts a driver that hands back text. */
function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

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
    snoozedUntil: threadState.snoozedUntil,
  };
  const myState = and(eq(threadState.threadId, threads.id), eq(threadState.memberId, memberId));

  // This member's state row for the `threads` row in scope, read through its primary key.
  const hidden = alias(threadState, "hidden");
  const snoozedNow = sql`${hidden.snoozedUntil} > now()`;
  const mine = and(eq(hidden.threadId, threads.id), eq(hidden.memberId, memberId));
  // A scalar subquery rather than `not exists`: the planner would otherwise materialize every
  // snooze of the member and compare each thread against all of them.
  const notSnoozed = sql`coalesce((${db
    .select({ until: hidden.snoozedUntil })
    .from(hidden)
    .where(mine)}), '-infinity'::timestamptz) <= now()`;
  const unreadAndAwake = notExists(
    db
      .select({ one: sql`1` })
      .from(hidden)
      .where(and(mine, sql`(${hidden.read} or ${snoozedNow})`)),
  );

  return {
    /**
     * One page of a view, newest first, with what a list row shows: the latest message's subject,
     * snippet and sender, up to five distinct senders (newest first), the message count and
     * whether any message has attachments.
     */
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
        eq(threads.archived, view === "archive"),
        lane ? laneFilter(lane) : undefined,
      ];
      if (before) {
        filters.push(
          sql`(${threads.lastMessageAt}, ${threads.id}) < (${before.lastMessageAt.toISOString()}::timestamptz, ${before.id})`,
        );
      }
      // The newest `limit` threads of each granted mailbox (an index range per mailbox), then
      // the newest `limit` of those. Cost follows grants × limit, not the size of the mail. The
      // lateral page is aliased `threads`, so the outer query reads it through the same columns.
      // Inbox skips this member's snoozed threads as it walks; the snoozed view starts from the
      // member's snoozes (`thread_state_member_snoozed_idx`), so it costs grants × snoozes.
      const order = [desc(threads.lastMessageAt), desc(threads.id)];
      const perMailbox =
        view === "snoozed"
          ? db
              .select(getTableColumns(threads))
              .from(hidden)
              .innerJoin(threads, eq(threads.id, hidden.threadId))
              .where(and(eq(hidden.memberId, memberId), snoozedNow, ...filters))
              .orderBy(...order)
              .limit(limit)
              .as("threads")
          : db
              .select(getTableColumns(threads))
              .from(threads)
              .where(and(...filters, view === "inbox" ? notSnoozed : undefined))
              .orderBy(...order)
              .limit(limit)
              .as("threads");
      const page = db
        .select(threadFields)
        .from(mailboxAccess)
        .innerJoin(members, eq(members.id, mailboxAccess.memberId))
        .crossJoinLateral(perMailbox)
        .leftJoin(threadState, myState)
        .where(
          and(
            eq(mailboxAccess.memberId, memberId),
            mailboxId ? eq(mailboxAccess.mailboxId, mailboxId) : undefined,
          ),
        )
        .orderBy(...order)
        .limit(limit)
        .as("page");

      // Row details for the final `limit` rows only, each from `messages_thread_id_sent_at_idx`.
      const latest = db
        .select({
          subject: messages.subject,
          fromName: messages.fromName,
          fromAddress: messages.fromAddress,
          // Collapse whitespace over a prefix only: clean text can be long.
          snippet:
            sql<string>`left(btrim(regexp_replace(left(${messages.cleanText}, ${SNIPPET_LENGTH * 3}), '[[:space:]]+', ' ', 'g')), ${SNIPPET_LENGTH})`.as(
              "snippet",
            ),
        })
        .from(messages)
        .where(eq(messages.threadId, page.id))
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(1)
        .as("latest");
      // Drizzle writes columns in a subquery's select list unqualified, which makes `page.id`
      // there ambiguous with `messages.id`: name it in full.
      const pageId = sql`"page"."id"`;
      const stats = db
        .select({
          messageCount: sql<number>`count(*)::int`.as("message_count"),
          hasAttachments: sql<boolean>`exists (
            select 1 from ${messages} m join ${attachments} a on a.message_id = m.id
            where m.thread_id = ${pageId})`.as("has_attachments"),
          participants: sql<Address[]>`(
            select coalesce(json_agg(json_build_object('name', p.from_name, 'address', p.from_address)
              order by p.sent_at desc, p.id desc), '[]'::json)
            from (
              select * from (
                select distinct on (lower(m.from_address)) m.from_name, m.from_address, m.sent_at, m.id
                from ${messages} m where m.thread_id = ${pageId}
                order by lower(m.from_address), m.sent_at desc, m.id desc
              ) senders order by sent_at desc, id desc limit ${MAX_PARTICIPANTS}
            ) p)`
            .mapWith((value: unknown) => parseJson<Address[]>(value))
            .as("participants"),
        })
        .from(messages)
        .where(eq(messages.threadId, page.id))
        .as("stats");

      const rows = await db
        .select()
        .from(page)
        .leftJoinLateral(latest, sql`true`)
        .crossJoinLateral(stats)
        .orderBy(desc(page.lastMessageAt), desc(page.id));
      return rows.map(({ page: thread, latest: message, stats: counts }) => ({
        ...thread,
        subject: message?.subject ?? "",
        snippet: message?.snippet ?? "",
        latestFrom: { name: message?.fromName ?? null, address: message?.fromAddress ?? "" },
        participants: counts.participants,
        messageCount: counts.messageCount,
        hasAttachments: counts.hasAttachments,
      }));
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
     * Unread threads in the inbox view (not archived, not snoozed by this member), per granted
     * mailbox and per lane. Each count stops at `UNREAD_COUNT_CAP`: imported history leaves most
     * old threads unread, and an exact count would read all of them. Each is an index range on
     * `threads_mailbox_page_idx` / `threads_mailbox_lane_page_idx` that stops at the cap.
     */
    async counts() {
      const unread = (lane?: Lane) =>
        sql<number>`(select count(*)::int from (${db
          .select({ one: sql`1` })
          .from(threads)
          .where(
            and(
              eq(threads.mailboxId, mailboxAccess.mailboxId),
              eq(threads.orgId, members.organizationId),
              eq(threads.archived, false),
              lane ? laneFilter(lane) : undefined,
              unreadAndAwake,
            ),
          )
          // The page index's order, so an ordered index scan can stop at the cap.
          .orderBy(desc(threads.lastMessageAt), desc(threads.id))
          .limit(UNREAD_COUNT_CAP)}) capped)`;
      const rows = await db
        .select({
          mailboxId: mailboxAccess.mailboxId,
          unread: unread(),
          needs_reply: unread("needs_reply"),
          waiting_on_them: unread("waiting_on_them"),
          fyi: unread("fyi"),
          noise: unread("noise"),
          unsure: unread("unsure"),
        })
        .from(mailboxAccess)
        .innerJoin(
          members,
          and(
            eq(members.id, mailboxAccess.memberId),
            eq(members.organizationId, mailboxAccess.orgId),
          ),
        )
        .where(eq(mailboxAccess.memberId, memberId))
        .orderBy(mailboxAccess.mailboxId);
      return rows.map(({ mailboxId, unread: total, ...lanes }) => ({
        mailboxId,
        unread: total,
        lanes,
      }));
    },

    /**
     * An outbox action this member asked for, or null. `lastError` is the raw error for
     * operators; apps get a user-safe message from the Worker instead.
     */
    async getAction(actionId: string) {
      const [row] = await db
        .select({
          id: mailActions.id,
          kind: mailActions.kind,
          status: mailActions.status,
          attempts: mailActions.attempts,
          lastError: mailActions.lastError,
        })
        .from(mailActions)
        .innerJoin(
          members,
          and(eq(members.id, mailActions.memberId), eq(members.organizationId, mailActions.orgId)),
        )
        .where(and(eq(mailActions.id, actionId), eq(mailActions.memberId, memberId)));
      return row ?? null;
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
     * Upserts this member's read/snooze state. Omitted fields keep their value; `snoozedUntil:
     * null` unsnoozes. Returns null when the member cannot see the thread.
     */
    async setThreadState(threadId: string, patch: { read?: boolean; snoozedUntil?: Date | null }) {
      const set: Partial<typeof threadState.$inferInsert> = { updatedAt: new Date() };
      if (patch.read !== undefined) set.read = patch.read;
      if (patch.snoozedUntil !== undefined) set.snoozedUntil = patch.snoozedUntil;

      const [row] = await db
        .insert(threadState)
        .select(
          db
            .select({
              orgId: threads.orgId,
              threadId: threads.id,
              memberId: mailboxAccess.memberId,
              read: sql`${patch.read ?? false}::boolean`.as("read"),
              snoozedUntil: sql`${patch.snoozedUntil?.toISOString() ?? null}::timestamptz`.as(
                "snoozed_until",
              ),
              updatedAt: sql`now()`.as("updated_at"),
            })
            .from(threads)
            .innerJoin(...threadGrant)
            .innerJoin(...threadOrg)
            .where(eq(threads.id, threadId)),
        )
        .onConflictDoUpdate({ target: [threadState.threadId, threadState.memberId], set })
        .returning();
      return row ?? null;
    },
  };
}
