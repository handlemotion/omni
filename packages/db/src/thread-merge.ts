// Merging two threads that turn out to be one conversation: a reply that arrived before its
// parent started a thread of its own, and the parent then joined the older one. The mail service
// calls this while storing a message; the rules for helpdesk state were agreed with the ticket
// workflow (ADR 0021): the most active status wins, the survivor keeps its assignee, SLA clocks
// keep the earliest time.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { queueMailEvents } from "./pending-mail-events.ts";
import { assignments, conversationEvents, threads } from "./schema/index.ts";

type Thread = typeof threads.$inferSelect;

const STATUS_RANK: Record<Thread["status"], number> = {
  open: 3,
  pending: 2,
  snoozed: 1,
  resolved: 0,
};
const PRIORITY_RANK: Record<Thread["priority"], number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export interface MergedThreads {
  /** The oldest thread, which now holds every message. */
  intoThreadId: string;
  /** Threads merged into it and deleted. Empty when there was nothing to merge. */
  fromThreadIds: string[];
}

/**
 * Merges `threadIds` (of one mailbox) into the oldest of them and deletes the rest. Messages,
 * notes, events, tags, drafts, notifications and per-member state move to the survivor. Two
 * threads that each belong to a different provider thread (Gmail) are separate conversations by
 * definition and are never merged: only the ones that agree with the survivor's provider thread
 * join it. Idempotent: ids that no longer exist are skipped.
 */
export async function mergeThreads(
  db: Db,
  input: { mailboxId: string; threadIds: string[] },
): Promise<MergedThreads> {
  const ids = [...new Set(input.threadIds)];
  return db.transaction(async (tx) => {
    // Locked in id order, so a merge and a Worker change on the same rows cannot deadlock.
    const rows = await tx
      .select()
      .from(threads)
      .where(and(eq(threads.mailboxId, input.mailboxId), inArray(threads.id, ids)))
      .orderBy(asc(threads.id))
      .for("update");
    const [survivor, ...rest] = rows.toSorted(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    if (!survivor) return { intoThreadId: ids[0] ?? "", fromThreadIds: [] };
    let providerThreadId = survivor.providerThreadId;
    const losers: Thread[] = [];
    for (const row of rest) {
      if (row.providerThreadId && providerThreadId && row.providerThreadId !== providerThreadId) {
        continue;
      }
      providerThreadId ??= row.providerThreadId;
      losers.push(row);
    }
    if (losers.length === 0) return { intoThreadId: survivor.id, fromThreadIds: [] };

    const all = [survivor, ...losers];
    const fromIds = losers.map((row) => row.id);
    const status = all.reduce(
      (best, row) => (STATUS_RANK[row.status] > STATUS_RANK[best] ? row.status : best),
      survivor.status,
    );
    const earliest = (pick: (row: Thread) => Date | null) =>
      all
        .map(pick)
        .filter((d): d is Date => d !== null)
        .toSorted((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const latest = (pick: (row: Thread) => Date | null) =>
      all
        .map(pick)
        .filter((d): d is Date => d !== null)
        .toSorted((a, b) => b.getTime() - a.getTime())[0] ?? null;

    // Each child row moves unless the survivor (or another merged thread, for the lowest ctid)
    // already has its twin: same member, tag or dedupe key. Twins go with the merged thread's
    // cascade.
    const from = sql`array[${sql.join(
      fromIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    const into = survivor.id;
    await tx.execute(sql`update messages set thread_id = ${into}, updated_at = now()
      where thread_id = any(${from})`);
    for (const table of ["notes", "drafts", "notifications", "triage_feedback"]) {
      await tx.execute(
        sql`update ${sql.identifier(table)} set thread_id = ${into} where thread_id = any(${from})`,
      );
    }
    await tx.execute(sql`update conversation_events e set thread_id = ${into}
      where e.thread_id = any(${from}) and (e.dedupe_key is null or (not exists (
        select 1 from conversation_events s where s.thread_id = ${into} and s.dedupe_key = e.dedupe_key)
        and e.ctid = (select min(d.ctid) from conversation_events d
          where d.thread_id = any(${from}) and d.dedupe_key = e.dedupe_key)))`);
    await tx.execute(sql`update thread_tags t set thread_id = ${into}
      where t.thread_id = any(${from}) and not exists (
        select 1 from thread_tags s where s.thread_id = ${into} and s.tag_id = t.tag_id)
      and t.ctid = (select min(d.ctid) from thread_tags d
        where d.thread_id = any(${from}) and d.tag_id = t.tag_id)`);
    // A member's read, done and deferred state on the whole conversation: unread if any part
    // was (no row means unread), done and deferred only as far as every part was.
    const every = sql`array[${sql.join(
      [into, ...fromIds].map((id) => sql`${id}`),
      sql`, `,
    )}]::text[]`;
    await tx.execute(sql`with combined as (
        delete from thread_state where thread_id = any(${every})
        returning org_id, member_id, read, done_through, snoozed_until)
      insert into thread_state (org_id, thread_id, member_id, read, done_through, snoozed_until)
      select org_id, ${into}, member_id,
        count(*) = ${fromIds.length + 1} and bool_and(read),
        case when count(*) = ${fromIds.length + 1} and bool_and(done_through is not null)
          then min(done_through) end,
        case when count(*) = ${fromIds.length + 1} and bool_and(snoozed_until is not null)
          then min(snoozed_until) end
      from combined group by org_id, member_id`);
    const [kept] = await tx
      .select({ threadId: assignments.threadId })
      .from(assignments)
      .where(eq(assignments.threadId, into));
    if (!kept) {
      await tx.execute(sql`update assignments set thread_id = ${into}
        where thread_id = (select min(thread_id) from assignments where thread_id = any(${from}))`);
    }

    // The merged threads go first: the provider thread id is unique per mailbox.
    await tx.delete(threads).where(inArray(threads.id, fromIds));
    await tx
      .update(threads)
      .set({
        lastMessageAt: latest((row) => row.lastMessageAt) ?? survivor.lastMessageAt,
        archived: all.every((row) => row.archived),
        providerThreadId,
        status,
        snoozedUntil:
          status === "snoozed"
            ? earliest((row) => (row.status === "snoozed" ? row.snoozedUntil : null))
            : null,
        resolvedAt: status === "resolved" ? latest((row) => row.resolvedAt) : null,
        assigneeMemberId:
          survivor.assigneeMemberId ?? losers.find((row) => row.assigneeMemberId)?.assigneeMemberId,
        priority: all.reduce(
          (best, row) => (PRIORITY_RANK[row.priority] > PRIORITY_RANK[best] ? row.priority : best),
          survivor.priority,
        ),
        customerId: survivor.customerId ?? losers.find((row) => row.customerId)?.customerId,
        firstResponseDueAt: earliest((row) => row.firstResponseDueAt),
        nextResponseDueAt: earliest((row) => row.nextResponseDueAt),
        resolutionDueAt: earliest((row) => row.resolutionDueAt),
        firstRespondedAt: earliest((row) => row.firstRespondedAt),
        // The summary covered one half; the next AI job writes one for the whole conversation.
        summary: null,
        summaryMessageId: null,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, into));
    await tx.insert(conversationEvents).values(
      losers.map((row) => ({
        id: uuidv7(),
        orgId: survivor.orgId,
        mailboxId: survivor.mailboxId,
        threadId: into,
        actorMemberId: null,
        kind: "merged" as const,
        data: { fromThreadId: row.id },
      })),
    );
    // Open apps showing a merged thread move to the survivor; queued with the merge, so a crash
    // cannot leave them holding a thread that no longer exists.
    await queueMailEvents(tx, [
      {
        type: "threads.merged",
        orgId: survivor.orgId,
        mailboxId: survivor.mailboxId,
        intoThreadId: into,
        fromThreadIds: fromIds,
      },
    ]);
    return { intoThreadId: into, fromThreadIds: fromIds };
  });
}
