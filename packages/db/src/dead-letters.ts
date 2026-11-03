// Work that will not run again, in one listing: queue jobs that reached the dead-letter queue
// (`dead_letters`) and outbox actions that exhausted their retries (`mail_actions` with status
// `failed`). Operator reads, not member-scoped: never serve them to a member's request.
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "./client.ts";
import { deadLetters, mailActions, threads } from "./schema/index.ts";

export interface DeadLetterInput {
  /** Null resolves it from `threadId` (jobs queued before they carried an org). */
  orgId: string | null;
  threadId?: string;
  queue: string;
  jobId: string;
  job: Record<string, unknown>;
  error: string | null;
  attempts: number;
  requestId: string | null;
}

/**
 * Records a dead job once per `jobId`; a second record (the DLQ consumer after the main
 * consumer's last attempt already wrote it) keeps the first, which has the error. Returns false
 * when nothing was written: already recorded, or no org could be found for it.
 */
export async function recordDeadLetter(db: Db, input: DeadLetterInput): Promise<boolean> {
  let orgId = input.orgId;
  if (!orgId && input.threadId) {
    const [thread] = await db
      .select({ orgId: threads.orgId })
      .from(threads)
      .where(eq(threads.id, input.threadId));
    orgId = thread?.orgId ?? null;
  }
  if (!orgId) return false;
  const rows = await db
    .insert(deadLetters)
    .values({
      orgId,
      queue: input.queue,
      jobId: input.jobId,
      job: input.job,
      error: input.error,
      attempts: input.attempts,
      requestId: input.requestId,
    })
    .onConflictDoNothing({ target: deadLetters.jobId })
    .returning({ id: deadLetters.id });
  return rows.length > 0;
}

export interface DeadLetterEntry {
  source: "queue" | "outbox";
  id: string;
  orgId: string;
  /** Queue name for a job; the action kind for an outbox action. */
  kind: string;
  error: string | null;
  attempts: number;
  requestId: string | null;
  /** Ids that locate the work (thread, mailbox); never its content. */
  ref: Record<string, unknown>;
  at: Date;
}

/** Newest first, both sources merged. `since` and `orgId` narrow it. */
export async function listDeadLetters(
  db: Db,
  options: { limit?: number; since?: Date; orgId?: string } = {},
): Promise<DeadLetterEntry[]> {
  const limit = options.limit ?? 50;
  const jobs = await db
    .select()
    .from(deadLetters)
    .where(
      and(
        options.orgId ? eq(deadLetters.orgId, options.orgId) : undefined,
        options.since ? gte(deadLetters.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(deadLetters.createdAt))
    .limit(limit);
  const actions = await db
    .select({
      id: mailActions.id,
      orgId: mailActions.orgId,
      mailboxId: mailActions.mailboxId,
      memberId: mailActions.memberId,
      kind: mailActions.kind,
      error: mailActions.lastError,
      attempts: mailActions.attempts,
      requestId: mailActions.requestId,
      at: mailActions.updatedAt,
    })
    .from(mailActions)
    .where(
      and(
        eq(mailActions.status, "failed"),
        options.orgId ? eq(mailActions.orgId, options.orgId) : undefined,
        options.since ? gte(mailActions.updatedAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(mailActions.updatedAt))
    .limit(limit);

  const entries: DeadLetterEntry[] = [
    ...jobs.map((row) => ({
      source: "queue" as const,
      id: row.jobId,
      orgId: row.orgId,
      kind: row.queue,
      error: row.error,
      attempts: row.attempts,
      requestId: row.requestId,
      ref: row.job,
      at: row.createdAt,
    })),
    ...actions.map((row) => ({
      source: "outbox" as const,
      id: row.id,
      orgId: row.orgId,
      kind: row.kind,
      error: row.error,
      attempts: row.attempts,
      requestId: row.requestId,
      ref: { mailboxId: row.mailboxId, memberId: row.memberId },
      at: row.at,
    })),
  ];
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
