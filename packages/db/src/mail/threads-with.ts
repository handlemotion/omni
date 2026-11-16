// `threadsWith` (ADR 0036 decision 4): the threads that involve some addresses or anyone at some
// domains, for a CRM record's timeline. It is a mail read like the others in `queries.ts`, on
// both doors, and it takes their grantee rule: a member sees a thread here exactly when they could
// open it in the inbox.
import { normalizeAddress } from "@omni/mail-core/addresses";
import { and, desc, eq, inArray, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxAccess, members, messages, threadParticipants, threads } from "../schema/index.ts";
import type { ThreadCursor } from "./queries.ts";

/** The most threads one call returns. */
export const THREADS_WITH_MAX = 100;

export interface ThreadsWithOptions {
  /** Any letter case; normalized as they are stored (`normalizeAddress`). */
  addresses?: readonly string[];
  /** Anyone at these domains (`acme.com`), any letter case. */
  domains?: readonly string[];
  /** Only threads older than this (`lastMessageAt`, then `id`): the last row of the page before. */
  before?: ThreadCursor;
  /** Default 50, at most `THREADS_WITH_MAX`. */
  limit?: number;
}

export interface ThreadWith {
  id: string;
  orgId: string;
  mailboxId: string;
  lastMessageAt: Date;
  /** The newest message's subject and text preview, as inbox rows show them. */
  subject: string;
  snippet: string;
  latestFrom: { name: string | null; address: string } | null;
}

/** Text with its links taken out, as list rows preview it (`queries.ts` `withoutLinks`). */
const preview = sql`left(btrim(regexp_replace(regexp_replace(left(m.clean_text, 1500), '\\(\\s*https?://[^\\s)]*\\s*\\)|https?://\\S+', ' ', 'g'), '\\s+', ' ', 'g')), 200)`;

/** `threadsWith` for the members `isGrantee` accepts (see `mailQueries` in `for-member.ts`). */
export function participantQueries(db: Db, isGrantee: (memberId: AnyColumn | SQL) => SQL) {
  return {
    /**
     * Threads any of `addresses` or anyone at `domains` wrote, received or was copied on, newest
     * first, one keyset page. Each granted mailbox is read on its own, through the participant
     * indexes, so cost follows grants and matches, not the size of the mail. A teammate's
     * personal mailbox is never granted, so it adds nothing, not even a count.
     */
    async threadsWith(options: ThreadsWithOptions): Promise<ThreadWith[]> {
      const addresses = [...new Set((options.addresses ?? []).map(normalizeAddress))].filter(
        Boolean,
      );
      // A domain is stored as `domainOf` gives it: lowercased, after the last `@`.
      const domains = [...new Set((options.domains ?? []).map(normalizeAddress))].filter(Boolean);
      if (addresses.length === 0 && domains.length === 0) return [];
      const limit = Math.min(Math.max(options.limit ?? 50, 1), THREADS_WITH_MAX);

      const involved = db
        .select({ threadId: threadParticipants.threadId })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.mailboxId, mailboxAccess.mailboxId),
            or(
              addresses.length ? inArray(threadParticipants.address, addresses) : undefined,
              domains.length ? inArray(threadParticipants.domain, domains) : undefined,
            ),
          ),
        );
      const filters: SQL[] = [
        eq(threads.mailboxId, mailboxAccess.mailboxId),
        eq(threads.orgId, members.organizationId),
        inArray(threads.id, involved),
      ];
      if (options.before) {
        filters.push(
          sql`(${threads.lastMessageAt}, ${threads.id}) < (${options.before.lastMessageAt.toISOString()}::timestamptz, ${options.before.id})`,
        );
      }
      // Per granted mailbox, its newest `limit` matches; then the newest `limit` of those.
      const page = db
        .select()
        .from(threads)
        .where(and(...filters))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(limit)
        .as("threads");
      const rows = await db
        .select({
          id: threads.id,
          orgId: threads.orgId,
          mailboxId: threads.mailboxId,
          lastMessageAt: threads.lastMessageAt,
          latest: sql<{
            subject: string;
            snippet: string;
            fromName: string | null;
            fromAddress: string;
          } | null>`(select jsonb_build_object('subject', m.subject, 'snippet', ${preview}, 'fromName', m.from_name, 'fromAddress', m.from_address) from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1)`.as(
            "latest",
          ),
        })
        .from(mailboxAccess)
        .innerJoin(members, eq(members.id, mailboxAccess.memberId))
        .crossJoinLateral(page)
        .where(isGrantee(mailboxAccess.memberId))
        .orderBy(desc(threads.lastMessageAt), desc(threads.id))
        .limit(limit);
      return rows.map(({ latest, ...row }) => ({
        ...row,
        subject: latest?.subject ?? "",
        snippet: latest?.snippet ?? "",
        latestFrom: latest ? { name: latest.fromName, address: latest.fromAddress } : null,
      }));
    },
  };
}
