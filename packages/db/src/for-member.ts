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

/** Newest messages per granted mailbox that contain every word of the query. */
const SEARCH_EXACT_HITS = 20;
/** Newest messages per granted mailbox for each query word on its own. */
const SEARCH_WORD_HITS = 25;
/** How many of each mailbox's newest messages are checked for a word in the sender address. */
const SEARCH_SENDER_WINDOW = 300;
/** Days over which the recency boost (up to 2x for mail sent now) halves. */
const SEARCH_RECENCY_DAYS = 30;
/** Query words matched one by one; more are ignored (the exact match still sees them all). */
const SEARCH_MAX_WORDS = 6;

/**
 * The words of a typed query, lowercased and deduplicated: runs of letters and digits only, so
 * each one is a safe `to_tsquery` operand and `ilike` pattern. Words after a leading `-` are
 * exclusions in web search syntax and are left out. `prefix` is true while the last word is
 * still being typed (no trailing space or closing quote), so "nightw" can find "Nightwatch".
 */
function searchWords(query: string) {
  const words = new Set<string>();
  for (const chunk of query.split(/\s+/)) {
    if (chunk.startsWith("-")) continue;
    for (const [word] of chunk.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) words.add(word);
  }
  return { words: [...words].slice(0, SEARCH_MAX_WORDS), prefix: /[\p{L}\p{N}]$/u.test(query) };
}

/** A plain-text passage of the message body around the query's matches. */
function headline(query: SQL, options: string) {
  return sql`ts_headline('english', regexp_replace(left(m.clean_text, 6000), '\\s+', ' ', 'g'), ${query}, ${`${options}, StartSel="", StopSel="", ShortWord=2`})`;
}

interface SearchRow {
  thread_id: string;
  message_id: string;
  mailbox_id: string;
  mailbox_address: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  sent_at: string | Date;
  last_message_at: string | Date;
  message_count: number;
  score: number;
  snippet: string;
  excerpt: string;
}

const { searchVector: _searchVector, ...messageColumns } = getTableColumns(messages);

/**
 * The only read path to mail data. Every query inner-joins `mailbox_access` for this member and
 * `members` to require the row's org to be the member's org, so a missing grant or a grant that
 * crosses orgs returns nothing.
 */
export function forMember(db: Db, memberId: string) {
  return mailQueries(db, (grantee) => sql`${grantee} = ${memberId}`);
}

/**
 * The same reads across every organization `userId` belongs to (ADR 0014): the union of what
 * each of their members can see. Each row keeps its `org_id`, and per-member state (read, done,
 * deferred) is the state of the member whose grant shows the row. The grant and org checks are
 * the ones `forMember` runs, so a user sees exactly what their members can, and nothing else.
 */
export function forUser(db: Db, userId: string) {
  return mailQueries(
    db,
    (grantee) => sql`${grantee} in (select um.id from ${members} um where um.user_id = ${userId})`,
  );
}

/**
 * Mail reads for the members `isGrantee` accepts: it gets a member id column and returns the
 * condition that column must meet. Every query inner-joins `mailbox_access` to a grantee and
 * `members` to require the row's org to be that member's org.
 */
function mailQueries(db: Db, isGrantee: (memberId: AnyColumn | SQL) => SQL) {
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

  const threadFields = {
    ...getTableColumns(threads),
    read: sql<boolean>`coalesce(${threadState.read}, false)`.as("read"),
    deferredUntil: threadState.snoozedUntil,
    done: sql<boolean>`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`.as(
      "done",
    ),
  };
  // State belongs to the member whose grant shows the thread: every query that reads it has
  // `mailbox_access` joined (for a user, one grant per mailbox: one member per org).
  const myState = and(
    eq(threadState.threadId, threads.id),
    eq(threadState.memberId, mailboxAccess.memberId),
  );
  // The two rules on that member's state row, applied inside the page scan as one primary-key
  // lookup per thread, so a page never comes back short. `counts` applies the same rules to
  // the joined row.
  const state = (filter: SQL) =>
    sql`exists (select 1 from ${threadState} s where s.thread_id = ${threads.id} and s.member_id = ${mailboxAccess.memberId} and (${filter}))`;
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
            isGrantee(mailboxAccess.memberId),
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
          orgId: threads.orgId,
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
        .groupBy(threads.orgId, threads.mailboxId);
      return rows;
    },

    /**
     * The grantee member who can see `threadId` (with a user, their member in the thread's org),
     * or null. Thread routes act as this member.
     */
    async memberFor(threadId: string) {
      const [row] = await db
        .select({
          id: members.id,
          orgId: members.organizationId,
          userId: members.userId,
          role: members.role,
        })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .where(eq(threads.id, threadId))
        .limit(1);
      return row ?? null;
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
        .where(and(eq(mailActions.id, actionId), eq(mailActions.memberId, mailboxAccess.memberId)));
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
     * Search, one row per thread, best match first. Recall is cheap and bounded per granted
     * mailbox, so cost follows grants and query words, not the size of the mail:
     *
     * - every word of `query` (web search syntax: quotes, `-word`), newest `SEARCH_EXACT_HITS`;
     * - each word on its own, the last one as a prefix while it is still being typed, newest
     *   `SEARCH_WORD_HITS` (a typed sentence such as "the invoice from Nightwatch last month"
     *   rarely has every word in the mail);
     * - a word inside a sender address (`billing@nightwatch.io` is one search token, so the
     *   index can't find "nightwatch" in it), within the newest `SEARCH_SENDER_WINDOW` messages.
     *
     * A message scores the words it matched, each weighted by how rare it was among the hits (a
     * word that filled its quota everywhere, like "last", counts least), plus one for matching
     * every word and one for a sender match, times a recency boost that halves over
     * `SEARCH_RECENCY_DAYS`. No per-row `ts_rank`: it would read every hit's search vector. A
     * thread takes its best message, which supplies `from`, `sentAt`, the `snippet` around the
     * match, and `excerpt`, a longer passage for a relevance judge.
     */
    async search(query: string, options: { mailboxId?: string; limit?: number } = {}) {
      const { mailboxId, limit = 20 } = options;
      const { words, prefix } = searchWords(query);
      const terms = words.map((w, i) => (prefix && i === words.length - 1 ? `${w}:*` : w));
      const exact = sql`websearch_to_tsquery('english', ${query})`;
      // Every word in one query, for the snippet: it highlights whichever words the message has.
      const any = terms.length ? sql`to_tsquery('english', ${terms.join(" | ")})` : exact;
      const recall = (source: SQL, filter: SQL, cap: number) =>
        sql`(select m.id, m.thread_id, m.sent_at, ${source} as source from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id and ${filter} order by m.sent_at desc, m.id desc limit ${cap})`;
      // One word: its own branch below already is the exact match (as a prefix while typing).
      const exactRecall =
        terms.length === 1
          ? sql`(select null::text as id, null::text as thread_id, null::timestamptz as sent_at, null::text as source where false)`
          : recall(sql`'exact'`, sql`m.search_vector @@ ${exact}`, SEARCH_EXACT_HITS);
      // One branch per word with the word as a constant, so the planner sees how common it is
      // (the GIN index for a rare word, a newest-first walk for a common one). A stop word turns
      // into an empty query, and its branch is skipped.
      const wordRecall = sql.join(
        terms.map(
          (term) =>
            sql` union all ${recall(sql`${term}::text`, sql`m.search_vector @@ to_tsquery('english', ${term}) and numnode(to_tsquery('english', ${term})) > 0`, SEARCH_WORD_HITS)}`,
        ),
      );
      const senderPatterns = words.filter((w) => w.length >= 3).map((w) => `%${w}%`);
      const senderRecall = senderPatterns.length
        ? sql`union all (select r.id, r.thread_id, r.sent_at, 'sender' as source from (select m.id, m.thread_id, m.sent_at, m.from_address from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id order by m.sent_at desc, m.id desc limit ${SEARCH_SENDER_WINDOW}) r where r.from_address ilike any (array[${sql.join(
            senderPatterns.map((pattern) => sql`${pattern}`),
            sql`, `,
          )}]))`
        : sql``;
      const rows = (await db.execute(sql`
        with hits as (
          select h.* from ${mailboxAccess} ma
          join ${members} mem on mem.id = ma.member_id
          cross join lateral (
            ${exactRecall}
            ${wordRecall}
            ${senderRecall}
          ) h
          where ${isGrantee(sql`ma.member_id`)} ${mailboxId ? sql`and ma.mailbox_id = ${mailboxId}` : sql``}
        ),
        weighted as (
          select id, thread_id, sent_at, source,
            case when source in ('exact', 'sender') then 1.0
              else ln(1 + (count(*) over ())::float8 / count(*) over (partition by source)) end as weight
          from hits
        ),
        scored as (
          select id, thread_id,
            sum(weight) * (1 + power(0.5, greatest(extract(epoch from now() - sent_at), 0) / 86400 / ${SEARCH_RECENCY_DAYS}::float8)) as score
          from (select distinct on (id, source) * from weighted) d
          group by id, thread_id, sent_at
        ),
        best as (
          select distinct on (thread_id) thread_id, id, score
          from scored order by thread_id, score desc, id desc
        ),
        top as (select * from best order by score desc, thread_id desc limit ${limit})
        select top.thread_id, m.id as message_id, t.mailbox_id, mb.address as mailbox_address,
          m.subject, m.from_name, m.from_address, m.sent_at, t.last_message_at, top.score::float8 as score,
          (select count(*)::int from ${messages} c where c.thread_id = t.id) as message_count,
          ${headline(any, "MaxWords=20, MinWords=10, MaxFragments=1")} as snippet,
          ${headline(any, "MaxWords=60, MinWords=40")} as excerpt
        from top
        join ${messages} m on m.id = top.id
        join ${threads} t on t.id = top.thread_id
        join ${mailboxes} mb on mb.id = t.mailbox_id
        order by top.score desc, top.thread_id desc
      `)) as unknown as SearchRow[]; // postgres-js: the rows themselves
      return rows.map((row) => ({
        threadId: row.thread_id,
        messageId: row.message_id,
        mailboxId: row.mailbox_id,
        mailboxAddress: row.mailbox_address,
        subject: row.subject,
        from: { name: row.from_name, address: row.from_address } satisfies Participant,
        sentAt: new Date(row.sent_at),
        lastMessageAt: new Date(row.last_message_at),
        messageCount: row.message_count,
        score: row.score,
        snippet: row.snippet,
        excerpt: row.excerpt,
      }));
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
