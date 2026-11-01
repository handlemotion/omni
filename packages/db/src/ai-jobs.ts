// Reads and writes for the Worker's AI queue consumer: trusted background code, not
// member-scoped. Every write is idempotent and none overrides a person's decision.
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { aiUsage, mailboxes, messages, threads } from "./schema/index.ts";

/** A thread with its messages oldest first and every address that counts as "us" in its org. */
export async function loadThreadForAi(db: Db, threadId: string) {
  const [thread] = await db
    .select({
      id: threads.id,
      orgId: threads.orgId,
      mailboxId: threads.mailboxId,
      triage: threads.triage,
      triageSource: threads.triageSource,
      summaryMessageId: threads.summaryMessageId,
    })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread) return null;

  const [rows, own] = await Promise.all([
    db
      .select({
        id: messages.id,
        subject: messages.subject,
        fromName: messages.fromName,
        fromAddress: messages.fromAddress,
        cleanText: messages.cleanText,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.sentAt), asc(messages.id)),
    db
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(eq(mailboxes.orgId, thread.orgId)),
  ]);
  return {
    ...thread,
    messages: rows,
    selfAddresses: new Set(own.map((m) => m.address.toLowerCase())),
  };
}

/** Files the thread. A person's re-sort (`triage_source = 'person'`) always wins. */
export async function saveTriage(
  db: Db,
  threadId: string,
  result: { bucket: NonNullable<typeof threads.$inferSelect.triage>; confidence: number },
) {
  const rows = await db
    .update(threads)
    .set({
      triage: result.bucket,
      triageConfidence: result.confidence,
      triageSource: "ai",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(threads.id, threadId),
        or(isNull(threads.triageSource), eq(threads.triageSource, "ai")),
      ),
    )
    .returning({ id: threads.id });
  return rows.length > 0;
}

/**
 * Stores the summary (null when there is nothing to say, e.g. noise) and marks `messageId` as
 * covered, which is what makes a redelivered job a no-op.
 */
export async function saveSummary(
  db: Db,
  threadId: string,
  input: { summary: string | null; messageId: string },
) {
  await db
    .update(threads)
    .set({ summary: input.summary, summaryMessageId: input.messageId, updatedAt: new Date() })
    .where(eq(threads.id, threadId));
}

/** Today's spend for the org (UTC day). */
export async function getAiUsage(db: Db, orgId: string, day: string) {
  const [row] = await db
    .select({ tokensIn: aiUsage.tokensIn, tokensOut: aiUsage.tokensOut })
    .from(aiUsage)
    .where(and(eq(aiUsage.orgId, orgId), eq(aiUsage.day, day)));
  return row ?? { tokensIn: 0, tokensOut: 0 };
}

export async function addAiUsage(
  db: Db,
  orgId: string,
  day: string,
  usage: { tokensIn: number; tokensOut: number },
) {
  if (usage.tokensIn === 0 && usage.tokensOut === 0) return;
  await db
    .insert(aiUsage)
    .values({ orgId, day, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut })
    .onConflictDoUpdate({
      target: [aiUsage.orgId, aiUsage.day],
      set: {
        tokensIn: sql`${aiUsage.tokensIn} + excluded.tokens_in`,
        tokensOut: sql`${aiUsage.tokensOut} + excluded.tokens_out`,
      },
    });
}
