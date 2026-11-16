// New mail worth a desktop notification: of the messages an ingest just indexed for the first
// time, the ones someone else wrote to the mailbox lately. A first sync's backlog, a list or an
// auto-reply, and the mailbox's own sends are left out.
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Executor } from "./conversation-core.ts";
import { mailboxes, messages } from "../schema/index.ts";

/** Mail dated earlier than this before it arrives is history (a first sync), not new mail. */
export const ARRIVAL_WINDOW_MS = 60 * 60 * 1000;

/** The threads, by mailbox, that the messages `messageIds` arrived in as new mail. */
export async function newArrivals(
  db: Executor,
  messageIds: readonly string[],
  now = new Date(),
): Promise<Map<string, Set<string>>> {
  const arrived = new Map<string, Set<string>>();
  if (messageIds.length === 0) return arrived;
  const rows = await db
    .select({ mailboxId: messages.mailboxId, threadId: messages.threadId })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        inArray(messages.id, [...new Set(messageIds)]),
        eq(messages.automated, false),
        gte(messages.sentAt, new Date(now.getTime() - ARRIVAL_WINDOW_MS)),
        ne(sql`lower(${messages.fromAddress})`, sql`lower(${mailboxes.address})`),
      ),
    );
  for (const { mailboxId, threadId } of rows) {
    const threads = arrived.get(mailboxId) ?? new Set();
    threads.add(threadId);
    arrived.set(mailboxId, threads);
  }
  return arrived;
}
