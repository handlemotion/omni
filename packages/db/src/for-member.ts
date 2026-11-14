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
  businessHours,
  conversationEvents,
  drafts,
  mailActions,
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  members,
  messageLocations,
  messages,
  notes,
  notifications,
  slaDueAt,
  slaPolicies,
  tags,
  threadState,
  threadTags,
  threads,
  triageBucket,
  users,
} from "./schema/index.ts";
import {
  conversationCondition,
  messageCondition,
  type MessageFilters,
  type ThreadFilters,
} from "./thread-filters.ts";

/** Triage at or above this confidence files itself; below it lands in the Unsure lane. */
export const TRIAGE_AUTO_FILE_CONFIDENCE = 0.85;

export type Lane = (typeof triageBucket.enumValues)[number] | "unsure";

export const LANES = [...triageBucket.enumValues, "unsure"] as const satisfies readonly Lane[];

/**
 * Per-member triage views (ADR 0007, Later: ADR 0027, shared inboxes: ADR 0032). A thread is *done*
 * for a member while its `last_message_at` is at or before their `done_through`, and in *Later*
 * while their `snoozed_until` is in the future (`infinity` once moved there); done wins over Later.
 * On a shared inbox they are the member's own too: a conversation stays in each teammate's Inbox
 * until they mark it done, whoever owns it, whatever its status, whoever replied.
 *
 * - `inbox`: not archived, not done, not in Later. What still needs attention.
 * - `later`: not archived, in Later, not done. Stays until the member moves it back or done.
 * - `done`: done, archived or not.
 * - `archive`: archived (moved out of INBOX on the server; shared by everyone on the mailbox).
 * - `all`: every thread the member can see, whatever its state.
 */
export const THREAD_VIEWS = ["inbox", "later", "done", "archive", "all"] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];

/**
 * A shared inbox's helpdesk views (ADR 0021), read from the conversation columns on `threads`:
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

/** Membership of a helpdesk view; `me` is the member column `mine` compares with. */
function conversationViewFilter(view: ConversationView, me: AnyColumn): SQL | undefined {
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
      // The same expression as `threads_mailbox_sla_due_idx`, so the index serves it.
      return sql`(${threads.status} = 'open' and ${slaDueAt(threads)} <= now() + make_interval(mins => ${SLA_AT_RISK_MINUTES}))`;
    case "all":
      return undefined;
  }
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
/**
 * With filters, each recall branch takes this many of a mailbox's newest matches for the words,
 * then applies the filters to them. Filtering inside the recall makes Postgres expect almost no
 * rows and read the whole mailbox instead of walking its newest first (perf:explain: 18 ms to
 * 570 ms); a LIMITed subquery keeps the filter out of the recall's plan.
 */
const SEARCH_FILTER_WINDOW = 200;
/**
 * What a search recall reads of each message: what it returns and what `messageCondition` tests.
 * Never `m.*`: that would read every hit's search vector too.
 */
const RECALL_COLUMNS = sql.raw(
  'm.id, m.thread_id, m.sent_at, m.mailbox_id, m.from_address, m."to", m.cc',
);
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

/**
 * Text with its links taken out, for previews: a snippet of a newsletter is otherwise a run of
 * URLs. Takes the `( url )` the HTML-to-text step writes after a link's label as well.
 */
function withoutLinks(text: SQL) {
  return sql`regexp_replace(${text}, '\\(\\s*https?://[^\\s)]*\\s*\\)|https?://\\S+', ' ', 'g')`;
}

/** A plain-text passage of the message body around the query's matches. */
function headline(query: SQL, options: string) {
  return sql`ts_headline('english', regexp_replace(${withoutLinks(sql`left(m.clean_text, 6000)`)}, '\\s+', ' ', 'g'), ${query}, ${`${options}, StartSel="", StopSel="", ShortWord=2`})`;
}

interface SearchRow {
  org_id: string;
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
  triage: (typeof triageBucket.enumValues)[number] | null;
  triage_source: string | null;
  triage_confidence: number | null;
  read: boolean;
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
 * Later) is the state of the member whose grant shows the row. The grant and org checks are
 * the ones `forMember` runs, so a user sees exactly what their members can, and nothing else.
 * With `scopeOrgId` (a session opened with a company's address, ADR 0024), only their member in
 * that organization counts.
 */
export function forUser(db: Db, userId: string, scopeOrgId?: string | null) {
  const inScope = scopeOrgId ? sql` and um.organization_id = ${scopeOrgId}` : sql``;
  return mailQueries(
    db,
    (grantee) =>
      sql`${grantee} in (select um.id from ${members} um where um.user_id = ${userId}${inScope})`,
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

  // Deprecated (ADR 0027): the old field, for tabs open from before Later. Later's `infinity`
  // reads back as a far-future time, which those tabs show as deferred.
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
  const laterRule = sql`s.snoozed_until > now()`;
  const viewFilters: Record<ThreadView, SQL[]> = {
    inbox: [eq(threads.archived, false), sql`not ${state(sql`${doneRule} or ${laterRule}`)}`],
    later: [
      eq(threads.archived, false),
      state(sql`${laterRule} and not coalesce(${doneRule}, false)`),
    ],
    // Not `exists`: Postgres plans that as a join against every one of the member's state rows,
    // per mailbox (perf:explain: 250 ms). A scalar subquery on the primary key is checked per
    // thread as the page index is walked newest first, so the scan stops at `limit` done threads.
    // No row, or no `done_through`, compares as null: not done.
    done: [
      sql`${threads.lastMessageAt} <= (select s.done_through from ${threadState} s where s.thread_id = ${threads.id} and s.member_id = ${mailboxAccess.memberId})`,
    ],
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
    } | null>`(select jsonb_build_object('subject', m.subject, 'fromName', m.from_name, 'fromAddress', m.from_address, 'snippet', left(btrim(regexp_replace(${withoutLinks(sql`left(m.clean_text, 1500)`)}, '\\s+', ' ', 'g')), 200)) from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1)`.as(
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
        /** Only threads the member has not read. */
        unread?: boolean;
        /** Narrow by messages (some message matches all) and conversation state (ADR 0029). */
        filters?: ThreadFilters;
      } = {},
    ) {
      const { mailboxId, lane, view = "inbox", before, limit = 50, unread, filters: by } = options;
      const filters: (SQL | undefined)[] = [
        eq(threads.mailboxId, mailboxAccess.mailboxId),
        eq(threads.orgId, members.organizationId),
        ...viewFilters[view],
      ];
      if (lane) filters.push(laneFilter(lane));
      if (unread) filters.push(sql`not ${state(sql`s.read`)}`);
      // One exact sender: the threads holding their messages, found through
      // `messages_mailbox_from_address_idx` (a rare sender would otherwise mean walking every
      // thread). The other conditions still apply below.
      const sender = by?.from?.includes("@") ? by.from.toLowerCase() : undefined;
      if (sender) {
        filters.push(
          sql`${threads.id} in (select ms.thread_id from ${messages} ms where ms.mailbox_id = ${threads.mailboxId} and lower(ms.from_address) = ${sender})`,
        );
      }
      const matching = by && messageCondition("mf", by);
      if (matching) {
        // A scalar subquery, not `exists`: Postgres would plan the semi-join as rare and read
        // every thread of the mailbox (perf:explain: 500 ms) instead of walking them newest first
        // and stopping at `limit`.
        filters.push(
          sql`coalesce((select true from ${messages} mf where mf.thread_id = ${threads.id} and ${matching} limit 1), false)`,
        );
      }
      if (by) filters.push(conversationCondition('"threads"', by));
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
     * One shared inbox's conversations in a helpdesk view, optionally only those with `tagId`,
     * one keyset page. Rows are `listThreads` rows plus their tags. Empty for a personal mailbox
     * or one no grantee can see.
     */
    async listConversations(options: {
      mailboxId: string;
      view: ConversationView;
      tagId?: string;
      after?: ConversationCursor;
      limit?: number;
    }) {
      const { mailboxId, view, tagId, after, limit = 50 } = options;
      const due = slaDueAt(threads);
      const atRisk = view === "sla_at_risk";
      const filters: (SQL | undefined)[] = [
        eq(threads.mailboxId, mailboxAccess.mailboxId),
        eq(threads.orgId, members.organizationId),
        conversationViewFilter(view, mailboxAccess.memberId),
        tagId
          ? sql`exists (select 1 from ${threadTags} tt where tt.thread_id = ${threads.id} and tt.tag_id = ${tagId})`
          : undefined,
      ];
      if (after) {
        filters.push(
          atRisk
            ? sql`(${due}, ${threads.id}) > (${after.at}::timestamptz, ${after.id})`
            : sql`(${threads.lastMessageAt}, ${threads.id}) < (${after.at}::timestamptz, ${after.id})`,
        );
      }
      const order = atRisk
        ? [sql`${due} asc`, sql`${threads.id} asc`]
        : [desc(threads.lastMessageAt), desc(threads.id)];
      // The page first (one index range), then the per-row summaries for its rows only: with the
      // summaries in the same query Postgres can hash a subquery over every attachment instead.
      const page = db
        .select()
        .from(threads)
        .where(and(...filters))
        .orderBy(...order)
        .limit(limit)
        .as("threads");
      const rows = await db
        .select({
          ...rowFields,
          slaDueAt: sql<Date | null>`${due}`.mapWith(threads.lastMessageAt).as("sla_due_at"),
          /** This row's keyset `at` (see `ConversationCursor`). */
          pageAt:
            sql<string>`to_char((${atRisk ? due : threads.lastMessageAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
              "page_at",
            ),
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
        .orderBy(...order);
      return rows.map(({ latest, ...row }) => ({
        ...row,
        unread: !row.read,
        subject: latest?.subject ?? "",
        snippet: latest?.snippet ?? "",
        latestFrom: latest ? { name: latest.fromName, address: latest.fromAddress } : null,
      }));
    },

    /**
     * Per granted shared inbox: how many conversations each helpdesk view holds (`resolved`
     * excepted: it only grows), and open or pending ones per tag.
     */
    async conversationCounts(options: { mailboxId?: string } = {}) {
      const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;
      const views = CONVERSATION_VIEWS.filter((v) => v !== "resolved" && v !== "all");
      const [rows, tagRows] = await Promise.all([
        db
          .select({
            orgId: threads.orgId,
            mailboxId: threads.mailboxId,
            views: sql<
              Record<Exclude<ConversationView, "resolved" | "all">, number>
            >`jsonb_build_object(${sql.join(
              views.map(
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
          .where(
            and(
              eq(mailboxes.kind, "shared"),
              sql`${threads.status} <> 'resolved'`,
              options.mailboxId ? eq(threads.mailboxId, options.mailboxId) : undefined,
            ),
          )
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
          .where(
            and(
              sql`${threads.status} in ('open', 'pending')`,
              options.mailboxId ? eq(threads.mailboxId, options.mailboxId) : undefined,
            ),
          )
          .groupBy(threads.mailboxId, threadTags.tagId),
      ]);
      return rows.map((row) => ({
        ...row,
        tags: Object.fromEntries(
          tagRows.filter((t) => t.mailboxId === row.mailboxId).map((t) => [t.tagId, t.count]),
        ),
      }));
    },

    /**
     * Thread counts per granted mailbox, for the sidebar: inbox (unread too), later, and each
     * lane within the inbox. The same rules as `listThreads`.
     */
    async counts() {
      // This member's state row is joined already; no per-thread lookup.
      const done = sql`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`;
      const inLater = sql`coalesce(${threadState.snoozedUntil} > now(), false)`;
      const later = sql`(${inLater} and not ${done})`;
      const inbox = sql`not (${inLater} or ${done})`;
      const unread = sql`coalesce(${threadState.read}, false) = false`;
      const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;
      const rows = await db
        .select({
          orgId: threads.orgId,
          mailboxId: threads.mailboxId,
          inbox: count(inbox),
          unread: count(and(inbox, unread)!),
          later: count(later),
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
    /** The grantee whose grant shows `mailboxId` (ADR 0024: write from any address you can open). */
    async memberForMailbox(mailboxId: string) {
      const [grant, org] = access(mailboxes.id, mailboxes.orgId);
      const [row] = await db
        .select({
          id: members.id,
          orgId: members.organizationId,
          userId: members.userId,
          role: members.role,
        })
        .from(mailboxes)
        .innerJoin(...grant)
        .innerJoin(...org)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);
      return row ?? null;
    },

    /**
     * The grantee whose grant shows the mailbox a draft or an outbox action belongs to, so a
     * draft started or a send queued in another workspace can be saved, sent or undone from any
     * workspace (ADR 0024). Null when no grantee can open it.
     */
    async memberForResource(kind: "draft" | "action", id: string) {
      const table = kind === "draft" ? drafts : mailActions;
      const [row] = await db
        .select({ mailboxId: table.mailboxId })
        .from(table)
        .where(eq(table.id, id));
      return row ? this.memberForMailbox(row.mailboxId) : null;
    },

    /** Every mailbox the grantees can open, with its workspace: where they can send from. */
    async listMailboxes() {
      const [grant, org] = access(mailboxes.id, mailboxes.orgId);
      return db
        .select({
          id: mailboxes.id,
          orgId: mailboxes.orgId,
          address: mailboxes.address,
          kind: mailboxes.kind,
          provider: mailboxes.provider,
          status: mailboxes.status,
          role: mailboxAccess.role,
        })
        .from(mailboxes)
        .innerJoin(...grant)
        .innerJoin(...org)
        .orderBy(mailboxes.address);
    },

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

    /**
     * The personal Google accounts the grantees can see, each with the grantee whose grant shows
     * it and its own workspace (ADR 0024): what Settings lists and may disconnect.
     */
    async googleAccounts() {
      const [grant, org] = access(mailboxes.id, mailboxes.orgId);
      return db
        .select({
          id: mailboxes.id,
          orgId: mailboxes.orgId,
          address: mailboxes.address,
          status: mailboxes.status,
          memberId: mailboxAccess.memberId,
        })
        .from(mailboxes)
        .innerJoin(...grant)
        .innerJoin(...org)
        .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.kind, "personal")))
        .orderBy(mailboxes.address);
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

    /**
     * A shared conversation's workflow state (ADR 0021): status, assignee, priority, SLA due
     * times, its tags, and its timeline events oldest first. Null when no grantee can see it.
     */
    async getConversation(threadId: string) {
      const [[conversation], tagRows, events, noteRows] = await Promise.all([
        db
          .select({
            id: threads.id,
            orgId: threads.orgId,
            mailboxId: threads.mailboxId,
            mailboxKind: mailboxes.kind,
            status: threads.status,
            assigneeMemberId: threads.assigneeMemberId,
            priority: threads.priority,
            snoozedUntil: threads.snoozedUntil,
            resolvedAt: threads.resolvedAt,
            customerId: threads.customerId,
            firstRespondedAt: threads.firstRespondedAt,
            firstResponseDueAt: threads.firstResponseDueAt,
            nextResponseDueAt: threads.nextResponseDueAt,
            resolutionDueAt: threads.resolutionDueAt,
          })
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .where(eq(threads.id, threadId))
          .limit(1),
        db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(threadTags)
          .innerJoin(tags, eq(tags.id, threadTags.tagId))
          .innerJoin(threads, eq(threads.id, threadTags.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(threadTags.threadId, threadId))
          .orderBy(sql`lower(${tags.name})`),
        db
          .select({
            id: conversationEvents.id,
            kind: conversationEvents.kind,
            actorMemberId: conversationEvents.actorMemberId,
            data: conversationEvents.data,
            createdAt: conversationEvents.createdAt,
          })
          .from(conversationEvents)
          .innerJoin(threads, eq(threads.id, conversationEvents.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(conversationEvents.threadId, threadId))
          .orderBy(conversationEvents.createdAt, conversationEvents.id),
        db
          .select({
            id: notes.id,
            authorMemberId: notes.authorMemberId,
            body: notes.body,
            mentions: notes.mentions,
            createdAt: notes.createdAt,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .innerJoin(threads, eq(threads.id, notes.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(notes.threadId, threadId))
          .orderBy(notes.createdAt, notes.id),
      ]);
      if (!conversation) return null;
      // A user's grants can show a thread through one member only (one per org), so no duplicates.
      return { ...conversation, tags: tagRows, events, notes: noteRows };
    },

    /** A shared or personal inbox's tags by name. Null when no grantee can see the inbox. */
    /**
     * The shared inboxes the member is on, with every tag and what it is for (ADR 0033): the AI
     * settings page. An inbox the member is not on is left out, even for an owner.
     */
    async listSharedInboxTags() {
      const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);
      const inboxes = await db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(eq(mailboxes.kind, "shared"))
        .orderBy(mailboxes.address);
      if (inboxes.length === 0) return [];
      const rows = await db
        .select({
          id: tags.id,
          mailboxId: tags.mailboxId,
          name: tags.name,
          color: tags.color,
          description: tags.description,
        })
        .from(tags)
        .innerJoin(mailboxes, eq(mailboxes.id, tags.mailboxId))
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(eq(mailboxes.kind, "shared"))
        .orderBy(sql`lower(${tags.name})`, tags.id);
      return inboxes.map((inbox) => ({
        ...inbox,
        tags: rows
          .filter((tag) => tag.mailboxId === inbox.id)
          .map(({ mailboxId: _mailboxId, ...tag }) => tag),
      }));
    },

    async listTags(mailboxId: string) {
      const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);
      const [[visible], rows] = await Promise.all([
        db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1),
        db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .innerJoin(mailboxes, eq(mailboxes.id, tags.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(eq(tags.mailboxId, mailboxId))
          .orderBy(sql`lower(${tags.name})`, tags.id),
      ]);
      return visible ? rows : null;
    },

    /**
     * A thread's inbox and every member who can see it there (presence goes to them). Null when
     * no grantee can see the thread.
     */
    async threadAudience(threadId: string) {
      const [thread] = await db
        .select({ mailboxId: threads.mailboxId, orgId: threads.orgId })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread) return null;
      const rows = await db
        .select({ memberId: mailboxAccess.memberId })
        .from(mailboxAccess)
        .innerJoin(
          members,
          and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, thread.orgId)),
        )
        .where(eq(mailboxAccess.mailboxId, thread.mailboxId));
      return { mailboxId: thread.mailboxId, memberIds: rows.map((r) => r.memberId) };
    },

    /**
     * A shared inbox's SLA targets per priority, its business hours (null: always open) and
     * whether it auto-assigns. Null when no grantee can see the inbox.
     */
    async slaSettings(mailboxId: string) {
      const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);
      const visible = and(eq(mailboxes.id, mailboxId), eq(mailboxes.kind, "shared"));
      const [[mailbox], policies, [hours]] = await Promise.all([
        db
          .select({ id: mailboxes.id, autoAssign: mailboxes.autoAssign })
          .from(mailboxes)
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(visible)
          .limit(1),
        db
          .select({
            priority: slaPolicies.priority,
            firstResponseMinutes: slaPolicies.firstResponseMinutes,
            nextResponseMinutes: slaPolicies.nextResponseMinutes,
            resolutionMinutes: slaPolicies.resolutionMinutes,
            businessHoursOnly: slaPolicies.businessHoursOnly,
          })
          .from(slaPolicies)
          .innerJoin(mailboxes, eq(mailboxes.id, slaPolicies.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(visible)
          .orderBy(slaPolicies.priority),
        db
          .select({
            timezone: businessHours.timezone,
            windows: businessHours.windows,
            holidays: businessHours.holidays,
          })
          .from(businessHours)
          .innerJoin(mailboxes, eq(mailboxes.id, businessHours.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(visible)
          .limit(1),
      ]);
      if (!mailbox) return null;
      return { policies, businessHours: hours ?? null, autoAssign: mailbox.autoAssign };
    },

    /**
     * A shared inbox's report for `[from, to)`, from the event log and the messages it points at
     * (ADR 0023 for the clocks). Times are in seconds, wall clock, from the customer's first
     * message. Null when no grantee can see the inbox.
     * - `created`: conversations whose first customer message falls in the range, in total and by
     *   their current assignee and tags.
     * - `firstResponse`: conversations first answered in the range, and how long it took.
     * - `resolved`: resolutions in the range, how long they took, and who resolved them.
     */
    async inboxReport(mailboxId: string, range: { from: Date; to: Date }) {
      const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);
      const [mailbox] = await db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.kind, "shared")))
        .limit(1);
      if (!mailbox) return null;
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      // A customer's message: not ours (by address, or filed in Sent, as ingest decides), not a
      // machine's.
      const customer = (alias: string) => {
        const m = sql.raw(alias);
        return sql`${m}.automated = false and lower(${m}.from_address) <> lower(${mailbox.address})
          and not exists (
            select 1 from ${messageLocations} l
            join ${mailboxFolders} f on f.id = l.folder_id
            where l.message_id = ${m}.id and f.role = 'sent'
          )`;
      };
      // Conversations whose first customer message falls in the range.
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
      // `at` is when it happened (a late-indexed reply keeps its sent time), and picks the period.
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
      const [created, byAssignee, byTag, firstResponse, resolved, resolvedBy] = await Promise.all([
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
      ]);
      type Timing = { count: number; median: number | null; p90: number | null };
      const timingOf = (rows: unknown): Timing => {
        const row = (rows as unknown as Timing[])[0]!;
        const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));
        return { count: row.count, median: round(row.median), p90: round(row.p90) };
      };
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

    /**
     * Who a conversation in this inbox can be assigned to: every member of the inbox's org who
     * can see it, by name. Null when no grantee can see the inbox.
     */
    async mailboxAssignees(mailboxId: string) {
      const [mailboxGrant, mailboxOrg] = access(mailboxes.id, mailboxes.orgId);
      const [[visible], rows] = await Promise.all([
        db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1),
        db.execute(sql`
          select am.id as "memberId", u.name, u.email, u.image
          from ${mailboxes} mb
          join ${mailboxAccess} ga on ga.mailbox_id = mb.id and ${isGrantee(sql`ga.member_id`)}
          join ${members} gm on gm.id = ga.member_id and gm.organization_id = mb.org_id
          join ${mailboxAccess} aa on aa.mailbox_id = mb.id
          join ${members} am on am.id = aa.member_id and am.organization_id = mb.org_id
          join ${users} u on u.id = am.user_id
          where mb.id = ${mailboxId}
          order by u.name, am.id`),
      ]);
      if (!visible) return null;
      return (
        rows as unknown as { memberId: string; name: string; email: string; image: string | null }[]
      ).map((r) => ({ memberId: r.memberId, name: r.name, email: r.email, image: r.image }));
    },

    /**
     * The grantee's notifications, newest first, one keyset page; only those about conversations
     * they can still see. `unread` counts all their unread ones.
     */
    async listNotifications(
      options: { unreadOnly?: boolean; before?: ConversationCursor; limit?: number } = {},
    ) {
      const { unreadOnly = false, before, limit = 50 } = options;
      const visible = and(
        isGrantee(notifications.memberId),
        eq(mailboxAccess.memberId, notifications.memberId),
      );
      const [rows, [unread]] = await Promise.all([
        db
          .select({
            id: notifications.id,
            kind: notifications.kind,
            threadId: notifications.threadId,
            mailboxId: threads.mailboxId,
            noteId: notifications.noteId,
            actorMemberId: notifications.actorMemberId,
            data: notifications.data,
            readAt: notifications.readAt,
            createdAt: notifications.createdAt,
            /** This row's keyset `at` (see `ConversationCursor`). */
            pageAt: sql<string>`to_char(${notifications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            subject: sql<string>`coalesce((select m.subject from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1), '')`,
          })
          .from(notifications)
          .innerJoin(threads, eq(threads.id, notifications.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(
            and(
              visible,
              unreadOnly ? sql`${notifications.readAt} is null` : undefined,
              before
                ? sql`(${notifications.createdAt}, ${notifications.id}) < (${before.at}::timestamptz, ${before.id})`
                : undefined,
            ),
          )
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .innerJoin(threads, eq(threads.id, notifications.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(and(visible, sql`${notifications.readAt} is null`)),
      ]);
      return { notifications: rows, unread: unread?.count ?? 0 };
    },

    async getThread(threadId: string) {
      const [thread] = await this.getThreads([threadId]);
      return thread ?? null;
    },

    /**
     * The threads among `threadIds` a grantee can see, each with its messages oldest first and
     * their attachments, in the order asked for. Three queries whatever the count, each carrying
     * the access check; ids nobody can see are left out.
     */
    async getThreads(threadIds: readonly string[]) {
      if (threadIds.length === 0) return [];
      const ids = [...new Set(threadIds)];
      const [threadRows, rows, files] = await Promise.all([
        db
          .select({
            ...threadFields,
            mailboxAddress: mailboxes.address,
            mailboxKind: mailboxes.kind,
          })
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .leftJoin(threadState, myState)
          .where(inArray(threads.id, ids)),
        db
          .select(messageColumns)
          .from(messages)
          .innerJoin(...messageGrant)
          .innerJoin(...messageOrg)
          .where(inArray(messages.threadId, ids))
          .orderBy(messages.sentAt, messages.id),
        db
          .select(getTableColumns(attachments))
          .from(attachments)
          .innerJoin(messages, eq(messages.id, attachments.messageId))
          .innerJoin(...messageGrant)
          .innerJoin(...messageOrg)
          .where(inArray(messages.threadId, ids)),
      ]);
      const byId = new Map(threadRows.map((thread) => [thread.id, thread]));
      return ids.flatMap((id) => {
        const thread = byId.get(id);
        if (!thread) return [];
        return [
          {
            ...thread,
            messages: rows
              .filter((m) => m.threadId === id)
              .map((m) => ({
                ...m,
                attachments: files.filter((a) => a.messageId === m.id),
              })),
          },
        ];
      });
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
    async search(
      query: string,
      options: { mailboxId?: string; limit?: number; filters?: MessageFilters } = {},
    ) {
      const { mailboxId, limit = 20 } = options;
      // Filters apply to a window of each mailbox's newest matches (`SEARCH_FILTER_WINDOW`).
      const matching = options.filters && messageCondition("m", options.filters);
      const narrowed = matching ? sql` where ${matching}` : sql``;
      const { words, prefix } = searchWords(query);
      const terms = words.map((w, i) => (prefix && i === words.length - 1 ? `${w}:*` : w));
      const exact = sql`websearch_to_tsquery('english', ${query})`;
      // Every word in one query, for the snippet: it highlights whichever words the message has.
      const any = terms.length ? sql`to_tsquery('english', ${terms.join(" | ")})` : exact;
      const recall = (source: SQL, filter: SQL, cap: number) =>
        matching
          ? sql`(select m.id, m.thread_id, m.sent_at, ${source} as source from (select ${RECALL_COLUMNS} from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id and ${filter} order by m.sent_at desc, m.id desc limit ${SEARCH_FILTER_WINDOW}) m${narrowed} order by m.sent_at desc, m.id desc limit ${cap})`
          : sql`(select m.id, m.thread_id, m.sent_at, ${source} as source from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id and ${filter} order by m.sent_at desc, m.id desc limit ${cap})`;
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
      // The newest messages a sender match looks through (with filters, those of them that match).
      const senderWindow = matching
        ? sql`(select m.id, m.thread_id, m.sent_at, m.from_address from (select ${RECALL_COLUMNS} from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id order by m.sent_at desc, m.id desc limit ${SEARCH_SENDER_WINDOW}) m${narrowed}`
        : sql`(select m.id, m.thread_id, m.sent_at, m.from_address from ${messages} m where m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id order by m.sent_at desc, m.id desc limit ${SEARCH_SENDER_WINDOW}`;
      const senderPatterns = words.filter((w) => w.length >= 3).map((w) => `%${w}%`);
      const senderRecall = senderPatterns.length
        ? sql`union all (select r.id, r.thread_id, r.sent_at, 'sender' as source from ${senderWindow}) r where r.from_address ilike any (array[${sql.join(
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
        select t.org_id, top.thread_id, m.id as message_id, t.mailbox_id, mb.address as mailbox_address,
          m.subject, m.from_name, m.from_address, m.sent_at, t.last_message_at, top.score::float8 as score,
          t.triage, t.triage_source, t.triage_confidence,
          coalesce((select s.read from ${threadState} s join ${mailboxAccess} sa on sa.member_id = s.member_id and sa.mailbox_id = t.mailbox_id where s.thread_id = t.id and ${isGrantee(sql`sa.member_id`)} limit 1), false) as read,
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
        orgId: row.org_id,
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
        triage: row.triage,
        triageSource: row.triage_source,
        triageConfidence: row.triage_confidence,
        unread: !row.read,
        snippet: row.snippet,
        excerpt: row.excerpt,
      }));
    },

    /**
     * Upserts this member's state. Omitted fields keep their value; `null` clears one. `later`
     * moves the thread into Later (`snoozed_until = infinity`) or out of it. `deferredUntil`
     * serves only the deprecated `/defer` route, kept for tabs open from before Later.
     * `doneThrough` is capped at the thread's `last_message_at`, so it never covers a message
     * that has not arrived yet. Returns the row and whether the thread is done now, or null when
     * the member cannot see the thread.
     */
    async setThreadState(
      threadId: string,
      patch: {
        read?: boolean;
        later?: boolean;
        deferredUntil?: Date | null;
        doneThrough?: Date | null;
      },
    ) {
      const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
      const snoozedUntil =
        patch.later !== undefined ? (patch.later ? "infinity" : null) : iso(patch.deferredUntil);
      const setsSnooze = patch.later !== undefined || patch.deferredUntil !== undefined;
      const set: Partial<Record<"read" | "snoozedUntil" | "doneThrough" | "updatedAt", SQL>> = {
        updatedAt: sql`now()`,
      };
      if (patch.read !== undefined) set.read = sql`excluded.read`;
      if (setsSnooze) set.snoozedUntil = sql`excluded.snoozed_until`;
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
              snoozedUntil: sql`${snoozedUntil}::timestamptz`.as("snoozed_until"),
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
          later: sql<boolean>`coalesce(${threadState.snoozedUntil} > now(), false)`,
          deferredUntil: legacyDeferredUntil,
          doneThrough: threadState.doneThrough,
          done: sql<boolean>`coalesce((select ${threads.lastMessageAt} from ${threads} where ${threads.id} = ${threadState.threadId}) <= ${threadState.doneThrough}, false)`,
        });
      return row ?? null;
    },
  };
}
