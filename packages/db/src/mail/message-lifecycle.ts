import { and, eq, inArray, sql } from "drizzle-orm";
import { MAX_PRUNED_THREADS_PER_EVENT } from "@omni/contracts";
import type { Db } from "../client.ts";
import {
  mailActions,
  mailboxFolders,
  messageLocations,
  messages,
  threads,
} from "../schema/index.ts";
import { queueMailEvents } from "./pending-mail-events.ts";
import { rederiveParticipants } from "./thread-participants.ts";

/**
 * Messages of the mailbox with no IMAP copy left in any stored folder. A send still in the outbox
 * is not one: it was indexed when SMTP accepted it and its Sent copy is still to be filed.
 */
export async function orphanedMessages(db: Db, mailboxId: string) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`not exists (select 1 from ${messageLocations} l where l.message_id = ${messages.id})`,
        sql`not exists (select 1 from ${mailActions} a
          where a.mailbox_id = ${messages.mailboxId} and a.kind = 'send'
            and a.status in ('pending', 'running')
            and (a.payload->>'messageId' = ${messages.messageIdHeader}
              -- No Message-ID in the payload: the outbox derives one from the idempotency key
              -- (deterministicMessageId in apps/mail/src/outbox.ts).
              or (a.payload->>'messageId' is null and ${messages.messageIdHeader} like
                '<' || left(encode(sha256(convert_to('omni-send:' || a.idempotency_key, 'UTF8')), 'hex'), 32) || '@%')))`,
      ),
    );
  return rows.map((row) => row.id) satisfies string[];
}

/**
 * Deletes messages that were deleted on the server: of `messageIds`, those that still have no IMAP
 * copy. A thread left with no messages goes too (its per-member state and AI output cascade); a
 * thread that keeps some takes its last message time from what is left. `threadIds` are every
 * thread that lost a message, deleted or not. The caller decides when a
 * missing copy means deleted rather than mid-move (see `MailboxConnection.syncAll`).
 */
export const pruneMessages: (
  db: Db,
  input: { mailboxId: string; messageIds: string[] },
) => Promise<{ messages: number; threads: number; threadIds: string[] }> = async (db, input) => {
  if (input.messageIds.length === 0) return { messages: 0, threads: 0, threadIds: [] };
  const anyOf = (ids: string[]) =>
    sql`any(array(select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)))`;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          sql`${messages.id} = ${anyOf(input.messageIds)}`,
          sql`not exists (select 1 from ${messageLocations} l where l.message_id = ${messages.id})`,
        ),
      )
      .returning({ orgId: messages.orgId, threadId: messages.threadId });
    const threadIds = [...new Set(removed.map((row) => row.threadId))];
    const orgId = removed[0]?.orgId;
    if (threadIds.length === 0 || !orgId) return { messages: 0, threads: 0, threadIds };
    const emptied = await tx
      .delete(threads)
      .where(
        and(
          sql`${threads.id} = ${anyOf(threadIds)}`,
          sql`not exists (select 1 from ${messages} m where m.thread_id = ${threads.id})`,
        ),
      )
      .returning({ id: threads.id });
    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`(select max(m.sent_at) from ${messages} m where m.thread_id = ${threads.id})`,
        updatedAt: new Date(),
      })
      .where(sql`${threads.id} = ${anyOf(threadIds)}`);
    await rederiveParticipants(tx, threadIds);
    await queueMailEvents(
      tx,
      chunks(threadIds, MAX_PRUNED_THREADS_PER_EVENT).map((chunk) => ({
        type: "messages.pruned" as const,
        orgId,
        mailboxId: input.mailboxId,
        threadIds: chunk,
      })),
    );
    return { messages: removed.length, threads: emptied.length, threadIds };
  });
};

/**
 * Messages whose `message.created` the Worker has not accepted yet (`notify_pending`), oldest
 * first: the mail service died or the Worker was down before delivery. Re-sending is safe; the
 * Worker dedupes by message id.
 */
export async function pendingNotifications(db: Db, limit: number) {
  const rows = await db
    .select({
      orgId: messages.orgId,
      mailboxId: messages.mailboxId,
      threadId: messages.threadId,
      messageId: messages.id,
      role: mailboxFolders.role,
    })
    .from(messages)
    .leftJoin(mailboxFolders, eq(mailboxFolders.id, messages.folderId))
    .where(eq(messages.notifyPending, true))
    .orderBy(messages.id)
    .limit(limit);
  return rows.map(({ role, ...row }) => ({ ...row, folderRole: role ?? ("sent" as const) }));
}

/** The Worker accepted `message.created` for these messages. */
export async function markNotified(db: Db, messageIds: string[]) {
  if (messageIds.length === 0) return;
  await db
    .update(messages)
    .set({ notifyPending: false })
    .where(and(inArray(messages.id, messageIds), eq(messages.notifyPending, true)));
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out satisfies T[][];
}
