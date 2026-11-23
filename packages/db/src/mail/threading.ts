import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { messages, threads } from "../schema/index.ts";
import { rederiveParticipants } from "./thread-participants.ts";

export async function findMessageByHeader(db: Db, mailboxId: string, messageIdHeader: string) {
  const [row] = await db
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageIdHeader)));
  return row ?? null;
}

/** Thread id per known Message-ID, for joining a reply by In-Reply-To/References. */
export async function threadsByMessageIds(db: Db, mailboxId: string, messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ header: messages.messageIdHeader, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.messageIdHeader, messageIds)));
  return new Map(rows.map((row) => [row.header, row.threadId]));
}

/**
 * Thread of the newest stored message that names any of `messageIds` in its In-Reply-To or
 * References: a reply that arrived before this message, or a sibling with the same parent. Pass
 * the new message's own Message-ID and its reply ids.
 */
export async function threadReferencing(db: Db, mailboxId: string, messageIds: string[]) {
  if (messageIds.length === 0) return null;
  const ids = sql`array[${sql.join(
    messageIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`(${messages.inReplyTo} = any(${ids}) or ${messages.references} && ${ids})`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return row?.threadId ?? null;
}

/**
 * Threads holding a stored reply to `messageId` (it names it in In-Reply-To or References). More
 * than one, or one besides the thread the message joins, means the conversation was split while
 * this message was missing, and those threads merge (`mergeThreads`).
 */
export async function threadsReplyingTo(db: Db, mailboxId: string, messageId: string) {
  const rows = await db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`(${messages.inReplyTo} = ${messageId} or ${messages.references} @> array[${messageId}]::text[])`,
      ),
    );
  return rows.map((row) => row.threadId);
}

/**
 * Recent threads with this subject key and every address on their messages, for subject
 * threading. `since` bounds the scan; the threading rule applies its own window on top.
 */
export async function subjectThreadCandidates(
  db: Db,
  input: { mailboxId: string; subjectKey: string; since: Date; limit?: number },
) {
  const recent = await db
    .select({ id: threads.id, lastMessageAt: threads.lastMessageAt })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, input.mailboxId),
        eq(threads.subjectKey, input.subjectKey),
        gte(threads.lastMessageAt, input.since),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(input.limit ?? 20);
  if (recent.length === 0) return [];
  const rows = await db
    .select({
      threadId: messages.threadId,
      from: messages.fromAddress,
      to: messages.to,
      cc: messages.cc,
    })
    .from(messages)
    .where(
      inArray(
        messages.threadId,
        recent.map((t) => t.id),
      ),
    );
  const byThread = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byThread.get(row.threadId) ?? new Set<string>();
    set.add(row.from);
    for (const a of [...row.to, ...row.cc]) set.add(a.address);
    byThread.set(row.threadId, set);
  }
  return recent.map((t) => ({
    threadId: t.id,
    subjectKey: input.subjectKey,
    lastMessageAt: t.lastMessageAt,
    participants: [...(byThread.get(t.id) ?? [])],
  }));
}

/** Thread of a stored message in this mailbox, for filing a forward with what it forwards. */
export async function messageThread(db: Db, mailboxId: string, messageId: string) {
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.id, messageId)));
  return row?.threadId ?? null;
}

/**
 * Files a stored message under another thread (the provider grouped it elsewhere). The thread it
 * leaves is deleted when that left it empty, else its `last_message_at` is recomputed; the one it
 * joins moves forward to the message when it is newer.
 */
export async function moveMessageToThread(
  db: Db,
  input: { mailboxId: string; messageId: string; threadId: string },
) {
  await db.transaction(async (tx) => {
    const [moved] = await tx
      .select({ from: messages.threadId, sentAt: messages.sentAt })
      .from(messages)
      .where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.id, input.messageId)));
    if (!moved || moved.from === input.threadId) return;
    await tx
      .update(messages)
      .set({ threadId: input.threadId, updatedAt: new Date() })
      .where(eq(messages.id, input.messageId));
    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${moved.sentAt.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, input.threadId));
    const [emptied] = await tx
      .delete(threads)
      .where(
        and(
          eq(threads.id, moved.from),
          sql`not exists (select 1 from ${messages} m where m.thread_id = ${threads.id})`,
        ),
      )
      .returning({ id: threads.id });
    if (!emptied) {
      await tx
        .update(threads)
        .set({
          lastMessageAt: sql`(select max(m.sent_at) from ${messages} m where m.thread_id = ${threads.id})`,
          updatedAt: new Date(),
        })
        .where(eq(threads.id, moved.from));
    }
    await rederiveParticipants(tx, [moved.from, input.threadId]);
  });
}
