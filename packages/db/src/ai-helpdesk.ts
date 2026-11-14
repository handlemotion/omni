// What helpdesk triage changes on a shared conversation (ADR 0022, ADR 0033): priority, tags, the
// assignee, and resolving noise. Trusted background code (the AI queue), so no member access
// check. Each change goes through the workflow's own `applyConversationChange` with no actor and
// `source: "ai"`, and none goes over a person: a priority a member set holds, a tag a member
// removed is not added back, a conversation a member ever assigned (or unassigned) is not handed
// out again, and a status a member changed after the message arrived is left alone.

import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "./client.ts";
import { helpdeskTeammatesForAi } from "./ai-settings.ts";
import { type Priority, type Tx } from "./conversation-core.ts";
import { applyConversationChange } from "./conversations.ts";
import { conversationEvents, mailboxes, messages, tags, threads } from "./schema/index.ts";

/**
 * How long the AI job waits for a message's own ingest (`applyInboundMessage`) before triaging it
 * anyway. The Worker queues the job before it runs the ingest for the same batch, so a fast job
 * could otherwise resolve or assign first and have the ingest's status rule undo it. A message
 * older than this whose ingest never ran (mail from before the helpdesk) is triaged as it is.
 */
export const INGEST_WAIT_MS = 2 * 60_000;

/** The message's helpdesk ingest has not run yet, and may still: wait for it before triage. */
export async function awaitingIngest(db: Db, messageId: string, now = new Date()) {
  const [row] = await db
    .select({ applied: messages.workflowAppliedAt, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId));
  return (
    row !== undefined &&
    row.applied === null &&
    now.getTime() - row.createdAt.getTime() < INGEST_WAIT_MS
  );
}

/** At most this many of an inbox's tags are offered to triage, in name order. */
export const HELPDESK_TAGS_FOR_AI = 25;

/**
 * What triage needs to judge a shared inbox's customer message: its tags (name order) and the
 * teammates it may assign. Null for a personal mailbox, which gets no helpdesk triage.
 */
export async function helpdeskContextForAi(db: Db, mailboxId: string) {
  const [mailbox] = await db
    .select({ kind: mailboxes.kind })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  if (mailbox?.kind !== "shared") return null;
  const [inboxTags, teammates] = await Promise.all([
    db
      .select({ id: tags.id, name: tags.name, description: tags.description })
      .from(tags)
      .where(eq(tags.mailboxId, mailboxId))
      .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id))
      .limit(HELPDESK_TAGS_FOR_AI),
    helpdeskTeammatesForAi(db, mailboxId),
  ]);
  return { tags: inboxTags, teammates };
}

export interface AiHelpdeskChanges {
  priority: Priority;
  /** Tag ids, most likely first. Only added, never removed. */
  tagIds: readonly string[];
  /** The member to hand it to, when it is unassigned. */
  assigneeId: string | null;
  /** Triage filed the message as noise at the auto-file confidence: resolve it. */
  resolveNoise: boolean;
}

export type AiHelpdeskOutcome =
  /**
   * Not a shared conversation, `messageId` is no longer its latest message, or a teammate
   * re-sorted that message while the model ran.
   */
  | { applied: false }
  | {
      applied: true;
      changed: boolean;
      queuedActions: number;
      /** Members who got a new notification (the assignee): tell them in realtime. */
      notified: string[];
    };

/** A member (not the AI, not the system) wrote an event of `kind` on the conversation. */
async function personDid(
  tx: Tx,
  threadId: string,
  kind: (typeof conversationEvents.$inferSelect)["kind"],
  extra?: ReturnType<typeof sql>,
) {
  const [row] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.threadId, threadId),
        eq(conversationEvents.kind, kind),
        isNotNull(conversationEvents.actorMemberId),
        extra,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Applies triage of `messageId` to its conversation. Idempotent: run twice, the second run changes
 * nothing. Writes nothing when a newer message has arrived (its own job applies its triage).
 */
export async function applyAiHelpdeskTriage(
  db: Db,
  input: { threadId: string; messageId: string; changes: AiHelpdeskChanges; now?: Date },
): Promise<AiHelpdeskOutcome> {
  const { threadId, messageId, changes } = input;
  return db.transaction(async (tx): Promise<AiHelpdeskOutcome> => {
    const [thread] = await tx
      .select({
        kind: mailboxes.kind,
        status: threads.status,
        assigneeMemberId: threads.assigneeMemberId,
        triageSource: threads.triageSource,
        triageMessageId: threads.triageMessageId,
      })
      .from(threads)
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .where(eq(threads.id, threadId))
      .for("update", { of: threads });
    if (thread?.kind !== "shared") return { applied: false };
    // A teammate re-sorted this message while the model ran: their call stands, and none of the
    // model's changes follow from a bucket they overruled.
    if (thread.triageSource === "person" && thread.triageMessageId === messageId) {
      return { applied: false };
    }
    // Same order as `loadThreadForAi`: nothing in the thread sorts after `messageId`.
    const triaged = alias(messages, "triaged");
    const [latest] = await tx
      .select({
        createdAt: triaged.createdAt,
        newer: sql<boolean>`exists (
        select 1 from ${messages} m where m.thread_id = ${threadId}
          and (m.sent_at, m.id) > (${triaged.sentAt}, ${triaged.id}))`,
      })
      .from(triaged)
      .where(and(eq(triaged.id, messageId), eq(triaged.threadId, threadId)));
    if (!latest || latest.newer) return { applied: false };

    let changed = false;
    let queuedActions = 0;
    const notified: string[] = [];
    const apply = async (change: Parameters<typeof applyConversationChange>[1]["change"]) => {
      const result = await applyConversationChange(tx, {
        threadId,
        actorMemberId: null,
        change,
        now: input.now,
      });
      if (result.ok) {
        changed ||= result.changed;
        queuedActions += result.queuedActions;
        notified.push(...result.notified);
      }
    };

    if (!(await personDid(tx, threadId, "priority"))) {
      await apply({ type: "priority", priority: changes.priority, source: "ai" });
    }
    for (const tagId of changes.tagIds) {
      const removed = await personDid(
        tx,
        threadId,
        "tag_removed",
        sql`${conversationEvents.data}->>'tagId' = ${tagId}`,
      );
      if (!removed) await apply({ type: "tag", tagId, add: true, source: "ai" });
    }
    // Round-robin (or a person) got there first, or a person has had their say on who owns it.
    if (
      changes.assigneeId &&
      !thread.assigneeMemberId &&
      thread.status !== "resolved" &&
      !(await personDid(tx, threadId, "assigned"))
    ) {
      await apply({
        type: "assign",
        memberId: changes.assigneeId,
        expectedAssignee: null,
        source: "ai",
      });
    }
    if (changes.resolveNoise) {
      // A teammate who reopened or moved it since this message arrived has the last word.
      const touched = await personDid(
        tx,
        threadId,
        "status",
        gt(conversationEvents.createdAt, latest.createdAt),
      );
      if (!touched) await apply({ type: "resolve", reason: "ai_noise" });
    }
    return { applied: true, changed, queuedActions, notified };
  });
}
