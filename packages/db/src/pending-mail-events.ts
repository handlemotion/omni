// Mail events waiting for the Worker (`pending_mail_events`). Writers add a row in the same
// transaction as the change it reports; the mail service delivers rows oldest first and deletes
// each once the Worker accepted it.
import type { MailEvent } from "@omni/contracts";
import { MAX_PRUNED_THREADS_PER_EVENT } from "@omni/contracts";
import { asc, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { pendingMailEvents, threads } from "./schema/index.ts";

type Executor = Pick<Db, "insert">;

/** Queues events for delivery. Pass the transaction that makes the change they report. */
export async function queueMailEvents(
  db: Executor,
  events: Exclude<MailEvent, { type: "message.created" }>[],
) {
  if (events.length === 0) return;
  await db
    .insert(pendingMailEvents)
    .values(events.map((event) => ({ orgId: event.orgId, mailboxId: event.mailboxId, event })));
}

/**
 * Queues `threads.changed` for threads whose archived or read state just changed to follow the
 * server (another mail app), one event per mailbox and chunk. Pass the transaction that changed them.
 */
export async function queueThreadsChanged(db: Pick<Db, "insert" | "select">, threadIds: string[]) {
  if (threadIds.length === 0) return;
  const rows = await db
    .select({ id: threads.id, orgId: threads.orgId, mailboxId: threads.mailboxId })
    .from(threads)
    .where(inArray(threads.id, [...new Set(threadIds)]));
  const byMailbox = new Map<string, { orgId: string; threadIds: string[] }>();
  for (const row of rows) {
    const entry = byMailbox.get(row.mailboxId) ?? { orgId: row.orgId, threadIds: [] };
    entry.threadIds.push(row.id);
    byMailbox.set(row.mailboxId, entry);
  }
  const events = [...byMailbox].flatMap(([mailboxId, { orgId, threadIds: ids }]) => {
    const out = [];
    for (let i = 0; i < ids.length; i += MAX_PRUNED_THREADS_PER_EVENT) {
      const chunk = ids.slice(i, i + MAX_PRUNED_THREADS_PER_EVENT);
      out.push({ type: "threads.changed" as const, orgId, mailboxId, threadIds: chunk });
    }
    return out;
  });
  await queueMailEvents(db, events);
}

/** Undelivered events, oldest first. `event` is unchecked: validate before sending. */
export function pendingMailEventRows(db: Db, limit: number) {
  return db
    .select({ id: pendingMailEvents.id, event: pendingMailEvents.event })
    .from(pendingMailEvents)
    .orderBy(asc(pendingMailEvents.id))
    .limit(limit);
}

/** The Worker accepted these (or they were unreadable): they are done. */
export async function deletePendingMailEvents(db: Db, ids: string[]) {
  if (ids.length === 0) return;
  await db.delete(pendingMailEvents).where(inArray(pendingMailEvents.id, ids));
}
