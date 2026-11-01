import { and, desc, eq, getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  attachments,
  mailboxAccess,
  members,
  messages,
  threadState,
  threads,
  triageBucket,
} from "./schema/index.ts";

/** Triage at or above this confidence files itself; below it lands in the Unsure lane. */
export const TRIAGE_AUTO_FILE_CONFIDENCE = 0.85;

export type Lane = (typeof triageBucket.enumValues)[number] | "unsure";

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
    snoozedUntil: threadState.snoozedUntil,
  };
  const myState = and(eq(threadState.threadId, threads.id), eq(threadState.memberId, memberId));

  return {
    async listThreads(
      options: {
        mailboxId?: string;
        lane?: Lane;
        archived?: boolean;
        before?: ThreadCursor;
        limit?: number;
      } = {},
    ) {
      const { mailboxId, lane, archived = false, before, limit = 50 } = options;
      const filters: (SQL | undefined)[] = [
        eq(threads.mailboxId, mailboxAccess.mailboxId),
        eq(threads.orgId, members.organizationId),
        eq(threads.archived, archived),
      ];
      if (lane === "unsure") {
        filters.push(
          eq(threads.triageSource, "ai"),
          sql`${threads.triageConfidence} < ${TRIAGE_AUTO_FILE_CONFIDENCE}`,
        );
      } else if (lane) {
        filters.push(
          eq(threads.triage, lane),
          sql`(${threads.triageSource} = 'person' or ${threads.triageConfidence} >= ${TRIAGE_AUTO_FILE_CONFIDENCE})`,
        );
      }
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
      return db
        .select(threadFields)
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
    },

    async getThread(threadId: string) {
      // One round trip: the three reads are independent and each carries the access check.
      const [[thread], rows, files] = await Promise.all([
        db
          .select(threadFields)
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
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
