// Shared internals of the conversation workflow (ADR 0021): row shape, locking, events and
// notifications. Used by conversations.ts, conversation-notes.ts and friends; not exported
// from the package except for the types re-exported by conversations.ts.

import { type ConversationState } from "@omni/mail-core/conversation-status";
import { and, eq, exists, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import {
  conversationEvents,
  conversationPriority,
  conversationStatus,
  mailboxAccess,
  mailboxes,
  members,
  notifications,
  threads,
} from "../schema/index.ts";

export type Priority = (typeof conversationPriority.enumValues)[number];
export type Status = (typeof conversationStatus.enumValues)[number];
export const PRIORITIES = conversationPriority.enumValues;

/** A database or an open transaction: every function here nests as a savepoint inside one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export type ConversationChange =
  /** `reason` is kept on the event, e.g. `ai_noise` when triage resolved it. */
  | { type: "resolve"; reason?: string }
  | { type: "reopen" }
  | { type: "snooze"; until: Date }
  /** The snooze cron: wakes it only if its current snooze is over. */
  | { type: "snooze_expired" }
  /**
   * `null` unassigns. The assignee must be able to see the inbox. With `expectedAssignee`
   * (a member id, or `null` for unassigned) it changes nothing unless the conversation is still
   * assigned that way when locked, so two teammates claiming at once cannot both win.
   */
  | {
      type: "assign";
      memberId: string | null;
      expectedAssignee?: string | null;
      /** `ai`: triage handed it to the teammate whose role fits (ADR 0033). */
      source?: "ai";
    }
  /** `source: "ai"` marks a change triage made, so a member's later correction can be learned from. */
  | { type: "priority"; priority: Priority; source?: "ai" }
  | { type: "tag"; tagId: string; add: boolean; source?: "ai" };

export type ChangeFailure =
  | "not_found"
  /** Conversation actions are for shared inboxes; personal mailboxes keep ADR 0007. */
  | "personal_mailbox"
  /** The assignee cannot see this inbox. */
  | "not_assignable"
  /** The tag is not one of this inbox's. */
  | "unknown_tag"
  /** A snooze to a time already past. */
  | "invalid_snooze"
  /** `expectedAssignee` no longer holds: someone else assigned it first. */
  | "assignee_changed";

export type ChangeResult =
  | {
      ok: true;
      changed: boolean;
      conversation: ConversationRow;
      /** Outbox rows written (archive on resolve, back to INBOX on reopen): ping the mail service. */
      queuedActions: number;
      /** Members who got a new notification: tell them in realtime. */
      notified: string[];
    }
  | {
      ok: false;
      reason: ChangeFailure;
      /** With `assignee_changed`: the conversation as it is, so the caller can show who has it. */
      conversation?: ConversationRow;
    };

export const conversationColumns = {
  id: threads.id,
  orgId: threads.orgId,
  mailboxId: threads.mailboxId,
  status: threads.status,
  assigneeMemberId: threads.assigneeMemberId,
  priority: threads.priority,
  snoozedUntil: threads.snoozedUntil,
  resolvedAt: threads.resolvedAt,
  firstRespondedAt: threads.firstRespondedAt,
  firstResponseDueAt: threads.firstResponseDueAt,
  nextResponseDueAt: threads.nextResponseDueAt,
  resolutionDueAt: threads.resolutionDueAt,
  responseClockAt: threads.responseClockAt,
  resolutionClockAt: threads.resolutionClockAt,
  customerId: threads.customerId,
};

export type ConversationRow = {
  id: string;
  orgId: string;
  mailboxId: string;
  status: Status;
  assigneeMemberId: string | null;
  priority: Priority;
  snoozedUntil: Date | null;
  resolvedAt: Date | null;
  firstRespondedAt: Date | null;
  firstResponseDueAt: Date | null;
  nextResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  responseClockAt: Date | null;
  resolutionClockAt: Date | null;
  customerId: string | null;
};

/** `member` can see the mailbox, in its org. */
export function granted(db: Executor, memberId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(mailboxAccess)
      .innerJoin(members, eq(members.id, mailboxAccess.memberId))
      .where(
        and(
          eq(mailboxAccess.mailboxId, threads.mailboxId),
          eq(mailboxAccess.memberId, memberId),
          eq(members.organizationId, threads.orgId),
        ),
      ),
  );
}

/** Locks the conversation row for this transaction. Null when the actor cannot see it. */
export async function lockConversation(tx: Tx, threadId: string, actorMemberId: string | null) {
  const [row] = await tx
    .select({ ...conversationColumns, kind: mailboxes.kind })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), actorMemberId ? granted(tx, actorMemberId) : undefined))
    .for("update", { of: threads });
  return row ?? null;
}

export function stateOf(row: ConversationRow) {
  return {
    status: row.status,
    snoozedUntil: row.snoozedUntil,
    resolvedAt: row.resolvedAt,
  } satisfies ConversationState;
}

export interface EventInput {
  kind: (typeof conversationEvents.$inferInsert)["kind"];
  data: Record<string, unknown>;
  dedupeKey?: string;
}

export async function writeEvents(
  tx: Tx,
  row: ConversationRow,
  actorMemberId: string | null,
  events: EventInput[],
) {
  if (events.length === 0) return [];
  return tx
    .insert(conversationEvents)
    .values(
      events.map((event) => ({
        id: uuidv7(),
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        threadId: row.id,
        actorMemberId,
        kind: event.kind,
        data: event.data,
        dedupeKey: event.dedupeKey ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: conversationEvents.id, kind: conversationEvents.kind });
}

export type NotificationKind = (typeof notifications.$inferInsert)["kind"];

/**
 * Notifies members about this conversation, once per `dedupeKey` per member (a job that runs
 * twice notifies once). Returns the members who got a new notification.
 */
export async function notify(
  tx: Tx,
  row: ConversationRow,
  input: {
    memberIds: string[];
    kind: NotificationKind;
    actorMemberId: string | null;
    dedupeKey: string;
    noteId?: string;
    data?: Record<string, unknown>;
  },
) {
  const memberIds = [...new Set(input.memberIds)].filter((m) => m !== input.actorMemberId);
  if (memberIds.length === 0) return [];
  const rows = await tx
    .insert(notifications)
    .values(
      memberIds.map((memberId) => ({
        id: uuidv7(),
        orgId: row.orgId,
        memberId,
        kind: input.kind,
        threadId: row.id,
        noteId: input.noteId ?? null,
        actorMemberId: input.actorMemberId,
        data: { mailboxId: row.mailboxId, ...input.data },
        dedupeKey: input.dedupeKey,
      })),
    )
    .onConflictDoNothing()
    .returning({ memberId: notifications.memberId });
  return rows.map((r) => r.memberId);
}
