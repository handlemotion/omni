import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  conversationEvents,
  mailboxFolders,
  mailboxes,
  messageLocations,
  messages,
  threads,
} from "../schema/index.ts";
import {
  lockSharedConversation,
  type ConversationRow,
  type Executor,
} from "./conversation-core.ts";
import { applyStatus } from "./conversation-steps.ts";

const discarded = sql`t.status <> 'resolved'
  and exists (
    select 1 from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id = t.id and f.role in ('trash', 'junk')
      and l.created_at > coalesce((
        select max(e.created_at) from ${conversationEvents} e
        where e.thread_id = t.id and e.kind = 'status' and e.actor_member_id is not null),
        '-infinity'::timestamptz))
  and not exists (
    select 1 from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id = t.id and f.role in ('inbox', 'archive'))`;

/**
 * Shared conversations of the mailbox that were discarded in another mail app: not resolved,
 * moved to Trash or Junk since a teammate last changed their status, and in no Inbox or Archive.
 */
export async function discardedConversations(db: Executor, mailboxId: string) {
  const rows = (await db.execute(sql`
    select t.id from ${threads} t
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.kind = 'shared'
    where t.mailbox_id = ${mailboxId} and ${discarded}
    order by t.id`)) as unknown as { id: string }[];
  return rows.map((r) => r.id) satisfies string[];
}

/**
 * Resolves a conversation discarded in another mail app, checking again under the row lock (a
 * teammate may have reopened it since the mail service looked). Nothing moves on IMAP: its mail
 * is already out of INBOX, so the resolve's archive step finds nothing to file. Idempotent.
 */
export async function resolveDiscarded(db: Executor, input: { threadId: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db.transaction<{ changed: boolean; conversation: ConversationRow | null }>(async (tx) => {
    const locked = await lockSharedConversation(tx, input.threadId, null);
    if (!locked.ok) return { changed: false, conversation: null };
    const { row } = locked;
    const still = (await tx.execute(
      sql`select 1 from ${threads} t where t.id = ${row.id} and ${discarded}`,
    )) as unknown as unknown[];
    if (still.length === 0) return { changed: false, conversation: row };
    const applied = await applyStatus(tx, row, { type: "resolve" }, now, null, {
      data: { reason: "discarded_elsewhere" },
    });
    return { changed: applied.changed, conversation: applied.row };
  });
}

/** Snoozed conversations whose time has come, oldest first, for the snooze cron. */
export async function dueSnoozes(db: Executor, now: Date, limit = 500) {
  return db
    .select({ id: threads.id, mailboxId: threads.mailboxId, orgId: threads.orgId })
    .from(threads)
    .where(and(eq(threads.status, "snoozed"), lte(threads.snoozedUntil, now)))
    .orderBy(asc(threads.snoozedUntil))
    .limit(limit);
}
