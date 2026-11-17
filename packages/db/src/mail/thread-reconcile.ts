// Thread state derived from IMAP: where a thread's copies are and how they are flagged. Every
// sync writer calls this, so a change made in Omni, in another mail app, or by a full re-sync
// ends in the same rows (spec, "Sync rules").
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  mailboxAccess,
  mailboxes,
  mailboxFolders,
  messageLocations,
  messages,
  threadState,
  threads,
} from "../schema/index.ts";
import { queueThreadsChanged } from "./pending-mail-events.ts";

/**
 * Brings the threads of these messages (`messageIds`: a list of ids or a query selecting them) in
 * line with their IMAP copies:
 *
 * - Archived: a copy in INBOX means not archived; otherwise a copy in the archive, trash or junk
 *   folder means archived (out of the inbox: deleted or junked mail is not waiting for an answer).
 *   A thread with none of these (Sent only, another folder, or mid-move) keeps its state.
 * - Read, on personal mailboxes other than Google accounts: read when every copy has `\Seen`, for
 *   every member with access. Shared mailboxes keep read per person in Postgres and never look
 *   at `\Seen`.
 * - Done, on Google accounts (ADR 0044): Gmail's read is Omni's Done. Every copy `\Seen` means
 *   done (and read, and out of Later); otherwise a done thread is back in the Inbox, unread.
 *   Omni's own read state is not derived from Gmail: only `arrivedUnseen` (the first copy of a
 *   message, which Gmail shows unread) turns a thread unread.
 *
 * `report` queues `threads.changed` for the threads whose state changed. Returns how many did.
 */
export async function reconcileThreads(
  db: Pick<Db, "execute" | "insert" | "select">,
  messageIds: SQL,
  report = true,
  arrivedUnseen = false,
) {
  const summary = sql`
    select m.thread_id,
      bool_or(f.role = 'inbox') as in_inbox,
      bool_or(f.role in ('archive', 'trash', 'junk')) as filed,
      bool_and(${"\\Seen"}::text = any(l.flags)) as seen
    from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id in (select thread_id from ${messages} where id in (${messageIds}))
    group by m.thread_id`;
  const archived = await db.execute(sql`
    update ${threads} t set archived = not s.in_inbox, updated_at = now()
    from (${summary}) s
    where t.id = s.thread_id and (s.in_inbox or s.filed) and t.archived = s.in_inbox
    returning t.id`);
  const read = await db.execute(sql`
    insert into ${threadState} (org_id, thread_id, member_id, read)
    select t.org_id, t.id, a.member_id, s.seen
    from (${summary}) s
    join ${threads} t on t.id = s.thread_id
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.kind = 'personal' and mb.provider <> 'gmail'
    join ${mailboxAccess} a on a.mailbox_id = t.mailbox_id
    on conflict (thread_id, member_id) do update set read = excluded.read, updated_at = now()
    where ${threadState}.read is distinct from excluded.read
    returning thread_id as id, read, xmax = 0 as inserted`);
  // Google accounts. Read in Gmail: done through the newest message, unless it already is.
  const done = await db.execute(sql`
    insert into ${threadState} (org_id, thread_id, member_id, read, done_through)
    select t.org_id, t.id, a.member_id, true, t.last_message_at
    from (${summary}) s
    join ${threads} t on t.id = s.thread_id
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.provider = 'gmail'
    join ${mailboxAccess} a on a.mailbox_id = t.mailbox_id
    where s.seen
    on conflict (thread_id, member_id) do update
      set read = true, done_through = excluded.done_through, snoozed_until = null, updated_at = now()
    where ${threadState}.done_through is null
      or ${threadState}.done_through < excluded.done_through
    returning thread_id as id`);
  // Unread in Gmail: a done thread reopens, and new unread mail shows as unread. No row already
  // means both.
  const reopened = await db.execute(sql`
    update ${threadState} ts set done_through = null, read = false, updated_at = now()
    from (${summary}) s
    join ${threads} t on t.id = s.thread_id
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.provider = 'gmail'
    where ts.thread_id = t.id and not s.seen
      and (ts.done_through >= t.last_message_at or (${arrivedUnseen}::boolean and ts.read and exists (
        -- Indexed since the member last touched the thread. A copy found again after a folder
        -- reset is the first location of a message they may have opened since: not new mail.
        select 1 from ${messages} n where n.id in (${messageIds}) and n.created_at > ts.updated_at
      )))
    returning ts.thread_id as id`);
  // postgres-js returns the rows themselves. A new row that says unread shows what no row did.
  type ReadRow = { id: string; read: boolean; inserted: boolean };
  const changed = [
    ...(archived as unknown as { id: string }[]),
    ...(read as unknown as ReadRow[]).filter((row) => row.read || !row.inserted),
    ...(done as unknown as { id: string }[]),
    ...(reopened as unknown as { id: string }[]),
  ];
  const threadIds = [...new Set(changed.map((row) => row.id))];
  if (report) await queueThreadsChanged(db, threadIds);
  return threadIds.length;
}
