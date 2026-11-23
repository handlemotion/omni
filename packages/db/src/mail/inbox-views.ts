import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  folderRole,
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  members,
  messageLocations,
  messages,
  threadState,
  threads,
  triageBucket,
} from "../schema/index.ts";
import type { GrantScope } from "./grants.ts";
import { withLatest } from "./thread-preview.ts";
import { conversationCondition, messageCondition, type ThreadFilters } from "./thread-filters.ts";

/** Triage at or above this confidence files itself; below it lands in the Unsure lane. */
export const TRIAGE_AUTO_FILE_CONFIDENCE = 0.85;

export type Lane = (typeof triageBucket.enumValues)[number] | "unsure";

export const LANES = [...triageBucket.enumValues, "unsure"] as const satisfies readonly Lane[];

/**
 * Per-member triage views. A thread is *done*
 * for a member while its `last_message_at` is at or before their `done_through`, and in *Later*
 * while their `snoozed_until` is in the future (`infinity` once moved there); done wins over Later.
 * On a shared inbox they are the member's own too: a conversation stays in each teammate's Inbox
 * until they mark it done, whoever owns it, whatever its status, whoever replied.
 *
 * - `inbox`: not archived, not done, not in Later. What still needs attention. With no lane, only
 *   threads holding a message someone else sent: a new email you sent waits in Sent and in its
 *   lane (Awaiting reply) until someone answers it.
 * - `later`: not archived, in Later, not done. Stays until the member moves it back or done.
 * - `done`: done, archived or not.
 * - `archive`: archived (moved out of INBOX on the server; shared by everyone on the mailbox).
 * - `all`: every thread the member can see, whatever its state.
 * - `sent`, `trash`, `spam`: threads with a message filed in the mailbox's Sent, Trash or Junk
 *   folder on the server (`message_locations`), whatever the member's own state.
 */
export const THREAD_VIEWS = [
  "inbox",
  "later",
  "done",
  "archive",
  "all",
  "sent",
  "trash",
  "spam",
] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];

export interface ThreadCursor {
  lastMessageAt: Date;
  id: string;
}

export interface ListThreadsOptions {
  mailboxId?: string;
  lane?: Lane;
  view?: ThreadView;
  before?: ThreadCursor;
  limit?: number;
  unread?: boolean;
  filters?: ThreadFilters;
}

function laneFilter(lane: Lane) {
  return (
    lane === "unsure"
      ? sql`(${threads.triageSource} = 'ai' and ${threads.triageConfidence} < ${TRIAGE_AUTO_FILE_CONFIDENCE})`
      : sql`(${threads.triage} = ${lane} and (${threads.triageSource} = 'person' or ${threads.triageConfidence} >= ${TRIAGE_AUTO_FILE_CONFIDENCE}))`
  ) satisfies SQL;
}

const heardFrom = sql`exists (select 1 from ${messages} mh join ${mailboxes} mbh on mbh.id = mh.mailbox_id where mh.thread_id = ${threads.id} and lower(mh.from_address) <> lower(mbh.address))`;

const myStateMatches = (filter: SQL) =>
  sql`exists (select 1 from ${threadState} s where s.thread_id = ${threads.id} and s.member_id = ${mailboxAccess.memberId} and (${filter}))`;
const doneRule = sql`${threads.lastMessageAt} <= s.done_through`;
const laterRule = sql`s.snoozed_until > now()`;
const filedIn = (role: (typeof folderRole.enumValues)[number]) =>
  sql`coalesce((select true from ${messages} fm join ${messageLocations} fl on fl.message_id = fm.id join ${mailboxFolders} ff on ff.id = fl.folder_id where fm.thread_id = ${threads.id} and ff.role = ${role} limit 1), false)`;

const viewFilters: Record<ThreadView, SQL[]> = {
  inbox: [
    eq(threads.archived, false),
    sql`not ${myStateMatches(sql`${doneRule} or ${laterRule}`)}`,
  ],
  later: [
    eq(threads.archived, false),
    myStateMatches(sql`${laterRule} and not coalesce(${doneRule}, false)`),
  ],
  done: [
    sql`${threads.lastMessageAt} <= (select s.done_through from ${threadState} s where s.thread_id = ${threads.id} and s.member_id = ${mailboxAccess.memberId})`,
  ],
  archive: [eq(threads.archived, true)],
  all: [],
  sent: [filedIn("sent")],
  trash: [filedIn("trash")],
  spam: [filedIn("junk")],
};

function filterConditions(by: ThreadFilters) {
  const filters: SQL[] = [];
  const sender = by.from?.includes("@") ? by.from.toLowerCase() : undefined;
  if (sender) {
    filters.push(
      sql`${threads.id} in (select ms.thread_id from ${messages} ms where ms.mailbox_id = ${threads.mailboxId} and lower(ms.from_address) = ${sender})`,
    );
  }
  const matching = messageCondition("mf", by);
  if (matching) {
    filters.push(
      sql`coalesce((select true from ${messages} mf where mf.thread_id = ${threads.id} and ${matching} limit 1), false)`,
    );
  }
  const conversation = conversationCondition('"threads"', by);
  if (conversation) filters.push(conversation);
  return filters;
}

function threadListConditions(options: ListThreadsOptions, view: ThreadView) {
  const { lane, before, unread, filters: by } = options;
  const filters: (SQL | undefined)[] = [
    eq(threads.mailboxId, mailboxAccess.mailboxId),
    eq(threads.orgId, members.organizationId),
    ...viewFilters[view],
  ];
  if (lane) filters.push(laneFilter(lane));
  else if (view === "inbox") filters.push(heardFrom);
  if (unread) filters.push(sql`not ${myStateMatches(sql`s.read`)}`);
  if (by) filters.push(...filterConditions(by));
  if (before) {
    filters.push(
      sql`(${threads.lastMessageAt}, ${threads.id}) < (${before.lastMessageAt.toISOString()}::timestamptz, ${before.id})`,
    );
  }
  return filters;
}

/** The member's inbox: thread lists by view and lane, and the counts beside them. */
export function inboxViewQueries({
  db,
  isGrantee,
  threadGrant,
  threadOrg,
  myState,
  rowFields,
}: GrantScope) {
  return {
    async listThreads(options: ListThreadsOptions = {}) {
      const { mailboxId, view = "inbox", limit = 50 } = options;
      const page = db
        .select()
        .from(threads)
        .where(and(...threadListConditions(options, view)))
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
      return rows.map((row) => ({ ...withLatest(row), unread: !row.read }));
    },

    async counts() {
      const done = sql`coalesce(${threads.lastMessageAt} <= ${threadState.doneThrough}, false)`;
      const inLater = sql`coalesce(${threadState.snoozedUntil} > now(), false)`;
      const later = sql`(${inLater} and not ${done})`;
      const active = sql`not (${inLater} or ${done})`;
      const heard = db
        .select({ threadId: messages.threadId })
        .from(messages)
        .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
        .where(
          and(
            eq(messages.threadId, threads.id),
            sql`lower(${messages.fromAddress}) <> lower(${mailboxes.address})`,
            active,
          ),
        )
        .limit(1)
        .as("heard");
      const inbox = sql`${heard.threadId} is not null`;
      const unread = sql`coalesce(${threadState.read}, false) = false`;
      const count = (filter: SQL) => sql<number>`(count(*) filter (where ${filter}))::int`;
      return db
        .select({
          orgId: threads.orgId,
          mailboxId: threads.mailboxId,
          inbox: count(inbox),
          unread: count(and(inbox, unread)!),
          later: count(later),
          lanes: sql<Record<Lane, number>>`jsonb_build_object(${sql.join(
            LANES.map((lane) => sql`${lane}::text, ${count(and(active, laneFilter(lane))!)}`),
            sql`, `,
          )})`,
        })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .leftJoin(threadState, myState)
        .leftJoinLateral(heard, sql`true`)
        .where(eq(threads.archived, false))
        .groupBy(threads.orgId, threads.mailboxId);
    },
  };
}
