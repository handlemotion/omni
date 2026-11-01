import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
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
      const filters: (SQL | undefined)[] = [eq(threads.archived, archived)];
      if (mailboxId) filters.push(eq(threads.mailboxId, mailboxId));
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
      return db
        .select(threadFields)
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .leftJoin(threadState, myState)
        .where(and(...filters))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(limit);
    },

    async getThread(threadId: string) {
      const [thread] = await db
        .select(threadFields)
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .leftJoin(threadState, myState)
        .where(eq(threads.id, threadId));
      if (!thread) return null;

      const rows = await db
        .select(messageColumns)
        .from(messages)
        .innerJoin(...messageGrant)
        .innerJoin(...messageOrg)
        .where(eq(messages.threadId, threadId))
        .orderBy(messages.sentAt, messages.id);
      const files = rows.length
        ? await db
            .select()
            .from(attachments)
            .where(
              inArray(
                attachments.messageId,
                rows.map((m) => m.id),
              ),
            )
        : [];
      return {
        ...thread,
        messages: rows.map((m) => ({
          ...m,
          attachments: files.filter((a) => a.messageId === m.id),
        })),
      };
    },

    /** Full-text search over subject, sender and clean text. `query` uses web search syntax. */
    async search(query: string, options: { mailboxId?: string; limit?: number } = {}) {
      const { mailboxId, limit = 20 } = options;
      const tsquery = sql`websearch_to_tsquery('english', ${query})`;
      const rank = sql<number>`ts_rank(${messages.searchVector}, ${tsquery})`;
      return db
        .select({
          messageId: messages.id,
          threadId: messages.threadId,
          mailboxId: messages.mailboxId,
          subject: messages.subject,
          fromName: messages.fromName,
          fromAddress: messages.fromAddress,
          sentAt: messages.sentAt,
          rank,
        })
        .from(messages)
        .innerJoin(...messageGrant)
        .innerJoin(...messageOrg)
        .where(
          and(
            sql`${messages.searchVector} @@ ${tsquery}`,
            mailboxId ? eq(messages.mailboxId, mailboxId) : undefined,
          ),
        )
        .orderBy(desc(rank), desc(messages.sentAt))
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
