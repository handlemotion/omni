// Helpdesk conversation workflow (ADR 0021): every change to a shared conversation's status,
// assignee, priority or tags, with its `conversation_events` row, in one transaction. The status
// rules are `nextConversationState` from `@omni/mail-core`; nothing here decides a status itself.
//
// Callers: the Worker's conversation routes (as a member), the `message.created` ingest, the
// reply route (`applyAgentReply`), the AI queue (noise auto-resolve) and the snooze cron. Each
// may run twice, so every function is idempotent: a change that leaves the conversation as it was
// writes no event and queues nothing.
import type { MessageTarget } from "@omni/contracts";
import {
  nextConversationState,
  type ConversationEvent,
  type ConversationState,
} from "@omni/mail-core/conversation-status";
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import {
  conversationEvents,
  conversationPriority,
  conversationStatus,
  mailActions,
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  members,
  messageLocations,
  messages,
  notes,
  notifications,
  tags,
  threadTags,
  threads,
} from "./schema/index.ts";

export type Priority = (typeof conversationPriority.enumValues)[number];
export type Status = (typeof conversationStatus.enumValues)[number];
export const PRIORITIES = conversationPriority.enumValues;

/** A database or an open transaction: every function here nests as a savepoint inside one. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export type ConversationChange =
  /** `reason` is kept on the event, e.g. `ai_noise` when triage resolved it. */
  | { type: "resolve"; reason?: string }
  | { type: "reopen" }
  | { type: "snooze"; until: Date }
  /** The snooze cron: wakes it only if its current snooze is over. */
  | { type: "snooze_expired" }
  /** `null` unassigns. The assignee must be able to see the inbox. */
  | { type: "assign"; memberId: string | null }
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
  | "invalid_snooze";

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
  | { ok: false; reason: ChangeFailure };

const conversationColumns = {
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
  customerId: string | null;
};

/** `member` can see the mailbox, in its org. */
function granted(db: Executor, memberId: string) {
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
async function lockConversation(tx: Tx, threadId: string, actorMemberId: string | null) {
  const [row] = await tx
    .select({ ...conversationColumns, kind: mailboxes.kind })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), actorMemberId ? granted(tx, actorMemberId) : undefined))
    .for("update", { of: threads });
  return row ?? null;
}

function stateOf(row: ConversationRow): ConversationState {
  return { status: row.status, snoozedUntil: row.snoozedUntil, resolvedAt: row.resolvedAt };
}

interface EventInput {
  kind: (typeof conversationEvents.$inferInsert)["kind"];
  data: Record<string, unknown>;
  dedupeKey?: string;
}

async function writeEvents(
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

type NotificationKind = (typeof notifications.$inferInsert)["kind"];

/**
 * Notifies members about this conversation, once per `dedupeKey` per member (a job that runs
 * twice notifies once). Returns the members who got a new notification.
 */
async function notify(
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

/** Every IMAP copy of the thread's messages, grouped by folder, as outbox targets. */
async function folderTargets(tx: Tx, threadId: string) {
  const rows = await tx
    .select({
      folder: mailboxFolders.path,
      role: mailboxFolders.role,
      uidValidity: mailboxFolders.uidvalidity,
      uid: messageLocations.imapUid,
    })
    .from(messageLocations)
    .innerJoin(messages, eq(messages.id, messageLocations.messageId))
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .where(and(eq(messages.threadId, threadId), isNotNull(mailboxFolders.uidvalidity)))
    .orderBy(asc(mailboxFolders.path), asc(messageLocations.imapUid));
  const byFolder = new Map<string, MessageTarget & { role: (typeof rows)[number]["role"] }>();
  for (const row of rows) {
    const target = byFolder.get(row.folder) ?? {
      folder: row.folder,
      role: row.role,
      uidValidity: String(row.uidValidity),
      uids: [],
    };
    target.uids.push(row.uid);
    byFolder.set(row.folder, target);
  }
  return [...byFolder.values()];
}

/**
 * How long a resolve waits before its archive runs. Reopening inside it cancels the archive, so
 * an undo never has to move mail back. Reopening later moves the archived copies back to INBOX.
 */
export const ARCHIVE_DELAY_SECONDS = 10;

/**
 * Resolve files the mail (ADR 0021 §5): the INBOX copies are archived, and leaving resolved moves
 * the archived copies back to INBOX. Sent, Junk, Trash and other folders are left where they are.
 * Keyed by the status event, so each transition queues its moves once.
 */
async function fileMail(
  tx: Tx,
  row: ConversationRow,
  actorMemberId: string | null,
  direction: "archive" | "unarchive",
  eventId: string,
  requestId: string | undefined,
) {
  await tx
    .update(threads)
    .set({ archived: direction === "archive", updatedAt: new Date() })
    .where(eq(threads.id, row.id));
  if (direction === "unarchive") {
    // An archive still waiting out its delay never runs: the mail has not left INBOX yet.
    await tx
      .delete(mailActions)
      .where(
        and(
          eq(mailActions.mailboxId, row.mailboxId),
          eq(mailActions.kind, "archive"),
          eq(mailActions.status, "pending"),
          sql`${mailActions.idempotencyKey} like ${`conversation:${row.id}:%`}`,
        ),
      );
  }
  const targets = await folderTargets(tx, row.id);
  let actions: { kind: "archive" | "move"; payload: Record<string, unknown>; folder: string }[];
  if (direction === "archive") {
    actions = targets
      .filter((t) => t.role === "inbox")
      .map(({ role: _role, ...target }) => ({
        kind: "archive",
        payload: target,
        folder: target.folder,
      }));
  } else {
    const [inbox] = await tx
      .select({ path: mailboxFolders.path })
      .from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, row.mailboxId), eq(mailboxFolders.role, "inbox")))
      .limit(1);
    if (!inbox) return 0;
    actions = targets
      .filter((t) => t.role === "archive")
      .map(({ role: _role, ...target }) => ({
        kind: "move",
        payload: { ...target, destination: inbox.path },
        folder: target.folder,
      }));
  }
  if (actions.length === 0) return 0;
  const inserted = await tx
    .insert(mailActions)
    .values(
      actions.map((action) => ({
        id: uuidv7(),
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        memberId: actorMemberId,
        kind: action.kind,
        payload: action.payload,
        idempotencyKey: `conversation:${row.id}:${eventId}:${action.kind}:${action.folder}`,
        requestId: requestId ?? null,
        // A resolve can be undone for a while before the mail moves (the web app's undo).
        runAfter:
          action.kind === "archive"
            ? new Date(Date.now() + ARCHIVE_DELAY_SECONDS * 1000)
            : undefined,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: mailActions.id });
  return inserted.length;
}

interface Applied {
  row: ConversationRow;
  changed: boolean;
  queuedActions: number;
  /** Members who got a new notification from this change. */
  notified?: string[];
}

/**
 * Moves the conversation to `next` (from the status function), writes its status event and files
 * the mail. Returns the new row; unchanged when `next` reports no change.
 */
async function applyStatus(
  tx: Tx,
  row: ConversationRow,
  event: ConversationEvent,
  now: Date,
  actorMemberId: string | null,
  options: { requestId?: string; data?: Record<string, unknown>; dedupeKey?: string } = {},
): Promise<Applied> {
  const next = nextConversationState(stateOf(row), event, now);
  if (!next.changed) return { row, changed: false, queuedActions: 0 };
  const updated = {
    ...row,
    status: next.state.status,
    snoozedUntil: next.state.snoozedUntil,
    resolvedAt: next.state.resolvedAt,
  };
  await tx
    .update(threads)
    .set({
      status: updated.status,
      snoozedUntil: updated.snoozedUntil,
      resolvedAt: updated.resolvedAt,
      updatedAt: now,
    })
    .where(eq(threads.id, row.id));
  const [written] = await writeEvents(tx, row, actorMemberId, [
    {
      kind: "status",
      data: {
        from: row.status,
        to: updated.status,
        ...(updated.snoozedUntil ? { snoozedUntil: updated.snoozedUntil.toISOString() } : {}),
        cause: event.type,
        ...options.data,
      },
      dedupeKey: options.dedupeKey,
    },
  ]);
  // A dedupe key that already exists: another run applied this transition.
  if (!written) return { row, changed: false, queuedActions: 0 };
  let queuedActions = 0;
  if (updated.status === "resolved" && row.status !== "resolved") {
    queuedActions = await fileMail(
      tx,
      updated,
      actorMemberId,
      "archive",
      written.id,
      options.requestId,
    );
  } else if (row.status === "resolved" && updated.status !== "resolved") {
    queuedActions = await fileMail(
      tx,
      updated,
      actorMemberId,
      "unarchive",
      written.id,
      options.requestId,
    );
  }
  return { row: updated, changed: true, queuedActions };
}

/** Whether `memberId` can see `mailboxId` (and is in its org). */
async function canSee(tx: Tx, memberId: string, mailboxId: string, orgId: string) {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(mailboxAccess)
    .innerJoin(members, eq(members.id, mailboxAccess.memberId))
    .where(
      and(
        eq(mailboxAccess.mailboxId, mailboxId),
        eq(mailboxAccess.memberId, memberId),
        eq(members.organizationId, orgId),
      ),
    );
  return row !== undefined;
}

/** Sets the assignee and writes the `assigned` event. */
async function assign(
  tx: Tx,
  row: ConversationRow,
  memberId: string | null,
  actorMemberId: string | null,
  now: Date,
  data: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<Applied> {
  if (row.assigneeMemberId === memberId) return { row, changed: false, queuedActions: 0 };
  await tx
    .update(threads)
    .set({ assigneeMemberId: memberId, updatedAt: now })
    .where(eq(threads.id, row.id));
  const [event] = await writeEvents(tx, row, actorMemberId, [
    { kind: "assigned", data: { from: row.assigneeMemberId, to: memberId, ...data }, dedupeKey },
  ]);
  const notified =
    memberId && event
      ? await notify(tx, row, {
          memberIds: [memberId],
          kind: "assigned",
          actorMemberId,
          dedupeKey: `assigned:${event.id}`,
        })
      : [];
  return {
    row: { ...row, assigneeMemberId: memberId },
    changed: true,
    queuedActions: 0,
    notified,
  };
}

/**
 * Applies one change to a shared conversation as `actorMemberId` (who must be able to see it), or
 * as the system with `null` (no access check: trusted callers only).
 */
export async function applyConversationChange(
  db: Executor,
  input: {
    threadId: string;
    actorMemberId: string | null;
    change: ConversationChange;
    requestId?: string;
    /**
     * The request's `Idempotency-Key`. A retry of a request that already changed the conversation
     * changes nothing, so it cannot undo a teammate's change made in between.
     */
    idempotencyKey?: string;
    now?: Date;
  },
): Promise<ChangeResult> {
  const { threadId, actorMemberId, change } = input;
  const now = input.now ?? new Date();
  const dedupeKey = input.idempotencyKey
    ? `request:${actorMemberId ?? "system"}:${input.idempotencyKey}`
    : undefined;
  return db.transaction(async (tx): Promise<ChangeResult> => {
    const locked = await lockConversation(tx, threadId, actorMemberId);
    if (!locked) return { ok: false, reason: "not_found" };
    const { kind, ...row } = locked;
    if (kind !== "shared") return { ok: false, reason: "personal_mailbox" };
    if (dedupeKey) {
      const [seen] = await tx
        .select({ id: conversationEvents.id })
        .from(conversationEvents)
        .where(
          and(eq(conversationEvents.threadId, row.id), eq(conversationEvents.dedupeKey, dedupeKey)),
        );
      if (seen) {
        return { ok: true, changed: false, conversation: row, queuedActions: 0, notified: [] };
      }
    }

    let applied: Applied;
    switch (change.type) {
      case "resolve":
        applied = await applyStatus(tx, row, { type: "resolve" }, now, actorMemberId, {
          requestId: input.requestId,
          dedupeKey,
          data: change.reason ? { reason: change.reason } : undefined,
        });
        break;
      case "reopen":
        applied = await applyStatus(tx, row, { type: "reopen" }, now, actorMemberId, {
          requestId: input.requestId,
          dedupeKey,
        });
        break;
      case "snooze":
        if (change.until.getTime() <= now.getTime()) return { ok: false, reason: "invalid_snooze" };
        applied = await applyStatus(tx, row, change, now, actorMemberId, {
          requestId: input.requestId,
          dedupeKey,
        });
        break;
      case "snooze_expired":
        applied = await applyStatus(tx, row, change, now, actorMemberId);
        break;
      case "assign":
        if (change.memberId && !(await canSee(tx, change.memberId, row.mailboxId, row.orgId))) {
          return { ok: false, reason: "not_assignable" };
        }
        applied = await assign(tx, row, change.memberId, actorMemberId, now, {}, dedupeKey);
        break;
      case "priority":
        if (row.priority === change.priority) {
          applied = { row, changed: false, queuedActions: 0 };
          break;
        }
        await tx
          .update(threads)
          .set({ priority: change.priority, updatedAt: now })
          .where(eq(threads.id, row.id));
        await writeEvents(tx, row, actorMemberId, [
          {
            kind: "priority",
            data: {
              from: row.priority,
              to: change.priority,
              ...(change.source ? { source: change.source } : {}),
            },
            dedupeKey,
          },
        ]);
        applied = { row: { ...row, priority: change.priority }, changed: true, queuedActions: 0 };
        break;
      case "tag": {
        const [tag] = await tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, change.tagId), eq(tags.mailboxId, row.mailboxId)));
        if (!tag) return { ok: false, reason: "unknown_tag" };
        const touched = change.add
          ? await tx
              .insert(threadTags)
              .values({
                orgId: row.orgId,
                threadId: row.id,
                tagId: tag.id,
                addedByMemberId: actorMemberId,
              })
              .onConflictDoNothing()
              .returning({ tagId: threadTags.tagId })
          : await tx
              .delete(threadTags)
              .where(and(eq(threadTags.threadId, row.id), eq(threadTags.tagId, tag.id)))
              .returning({ tagId: threadTags.tagId });
        if (touched.length) {
          await tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, row.id));
          await writeEvents(tx, row, actorMemberId, [
            {
              kind: change.add ? "tag_added" : "tag_removed",
              data: { tagId: tag.id, ...(change.source ? { source: change.source } : {}) },
              dedupeKey,
            },
          ]);
        }
        applied = { row, changed: touched.length > 0, queuedActions: 0 };
        break;
      }
    }
    return {
      ok: true,
      changed: applied.changed,
      conversation: applied.row,
      queuedActions: applied.queuedActions,
      notified: applied.notified ?? [],
    };
  });
}

/**
 * A teammate replied in the conversation (the reply route, right after the send is queued): open
 * goes to pending, an unassigned conversation is claimed by whoever replied, and the first reply
 * records the first response. No-op on personal mailboxes.
 */
export async function applyAgentReply(
  db: Executor,
  input: { threadId: string; memberId: string; now?: Date; requestId?: string },
): Promise<ChangeResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<ChangeResult> => {
    const locked = await lockConversation(tx, input.threadId, input.memberId);
    if (!locked) return { ok: false, reason: "not_found" };
    const { kind, ...row } = locked;
    if (kind !== "shared") return { ok: false, reason: "personal_mailbox" };
    const status = await applyStatus(tx, row, { type: "agent_reply" }, now, input.memberId);
    const claimed = row.assigneeMemberId
      ? { row: status.row, changed: false }
      : await assign(tx, status.row, input.memberId, input.memberId, now, { cause: "first_reply" });
    const responded = await recordFirstResponse(tx, claimed.row, input.memberId, now);
    return {
      ok: true,
      changed: status.changed || claimed.changed || responded.changed,
      conversation: responded.row,
      queuedActions: status.queuedActions,
      notified: [],
    };
  });
}

async function recordFirstResponse(
  tx: Tx,
  row: ConversationRow,
  actorMemberId: string | null,
  at: Date,
  data: Record<string, unknown> = {},
) {
  if (row.firstRespondedAt) return { row, changed: false };
  await tx
    .update(threads)
    .set({ firstRespondedAt: at, firstResponseDueAt: null })
    .where(eq(threads.id, row.id));
  await writeEvents(tx, row, actorMemberId, [
    {
      kind: "first_response",
      data: { at: at.toISOString(), ...data },
      dedupeKey: "first_response",
    },
  ]);
  return { row: { ...row, firstRespondedAt: at, firstResponseDueAt: null }, changed: true };
}

export type InboundResult =
  | { applied: false }
  | {
      applied: true;
      direction: "customer" | "agent";
      changed: boolean;
      conversation: ConversationRow;
      queuedActions: number;
      /** Members who got a new notification: tell them in realtime. */
      notified: string[];
    };

/**
 * The `message.created` ingest for one message: a customer's message reopens the conversation
 * (unless automated), our own (from the inbox's address, or filed in Sent) is an agent reply.
 * Each message is applied once (`messages.workflow_applied_at`), so a redelivered event cannot
 * apply an old message over newer state. A Sent copy older than the customer's latest message is
 * history, not a reply to it, and leaves the status alone.
 */
export async function applyInboundMessage(
  db: Executor,
  input: { messageId: string; folderRole?: string; now?: Date },
): Promise<InboundResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<InboundResult> => {
    const [message] = await tx
      .update(messages)
      .set({ workflowAppliedAt: now })
      .where(and(eq(messages.id, input.messageId), isNull(messages.workflowAppliedAt)))
      .returning({
        threadId: messages.threadId,
        fromAddress: messages.fromAddress,
        automated: messages.automated,
        sentAt: messages.sentAt,
      });
    if (!message) return { applied: false };
    const locked = await lockConversation(tx, message.threadId, null);
    if (!locked || locked.kind !== "shared") return { applied: false };
    const [mailbox] = await tx
      .select({ address: mailboxes.address })
      .from(mailboxes)
      .where(eq(mailboxes.id, locked.mailboxId));
    const { kind: _kind, ...row } = locked;
    const ours =
      input.folderRole === "sent" ||
      message.fromAddress.toLowerCase() === mailbox?.address.toLowerCase();

    if (!ours) {
      const applied = await applyStatus(
        tx,
        row,
        { type: "customer_message", automated: message.automated },
        now,
        null,
        { data: { messageId: input.messageId } },
      );
      // The assignee hears when their customer writes back (not for an auto-reply).
      const notified =
        applied.row.assigneeMemberId && !message.automated
          ? await notify(tx, applied.row, {
              memberIds: [applied.row.assigneeMemberId],
              kind: "customer_reply",
              actorMemberId: null,
              dedupeKey: `customer_reply:${input.messageId}`,
              data: { messageId: input.messageId },
            })
          : [];
      return {
        applied: true,
        direction: "customer",
        changed: applied.changed,
        conversation: applied.row,
        queuedActions: applied.queuedActions,
        notified,
      };
    }

    const [newer] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, row.id),
          gt(messages.sentAt, message.sentAt),
          eq(messages.automated, false),
          ne(sql`lower(${messages.fromAddress})`, (mailbox?.address ?? "").toLowerCase()),
        ),
      )
      .limit(1);
    // A Sent copy indexed after the customer already answered is history: the status stays, but
    // it was still a response, so the first response is recorded.
    const status = newer
      ? { row, changed: false, queuedActions: 0 }
      : await applyStatus(tx, row, { type: "agent_reply" }, now, null, {
          data: { messageId: input.messageId },
        });
    // Only a reply after a customer message responds to someone.
    const [asked] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, row.id),
          lte(messages.sentAt, message.sentAt),
          ne(sql`lower(${messages.fromAddress})`, (mailbox?.address ?? "").toLowerCase()),
        ),
      )
      .limit(1);
    const responded = asked
      ? await recordFirstResponse(tx, status.row, null, message.sentAt, {
          messageId: input.messageId,
        })
      : { row: status.row, changed: false };
    return {
      applied: true,
      direction: "agent",
      changed: status.changed || responded.changed,
      conversation: responded.row,
      queuedActions: status.queuedActions,
      notified: [],
    };
  });
}

/** Snoozed conversations whose time has come, oldest first, for the snooze cron. */
export async function dueSnoozes(db: Executor, now: Date, limit = 500) {
  return db
    .select({ id: threads.id, mailboxId: threads.mailboxId, orgId: threads.orgId })
    .from(threads)
    .where(and(eq(threads.status, "snoozed"), lte(threads.snoozedUntil, now)))
    .orderBy(asc(threads.snoozedUntil))
    .limit(limit);
}

// Tags: an inbox's list, managed by anyone who can see the inbox.

async function memberSeesMailbox(db: Executor, memberId: string, mailboxId: string) {
  const [row] = await db
    .select({ orgId: mailboxes.orgId, kind: mailboxes.kind })
    .from(mailboxes)
    .innerJoin(
      mailboxAccess,
      and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.memberId, memberId)),
    )
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .where(eq(mailboxes.id, mailboxId));
  return row ?? null;
}

const tagColumns = { id: tags.id, name: tags.name, color: tags.color };

/**
 * Creates a tag, or returns the one with the same name ignoring case (so a retry or a teammate
 * typing it at the same time gets the same tag). Null when the member cannot see the inbox.
 */
export async function createTag(
  db: Executor,
  memberId: string,
  mailboxId: string,
  input: { name: string; color?: string | null },
) {
  const mailbox = await memberSeesMailbox(db, memberId, mailboxId);
  if (!mailbox) return null;
  const [created] = await db
    .insert(tags)
    .values({
      id: uuidv7(),
      orgId: mailbox.orgId,
      mailboxId,
      name: input.name,
      color: input.color ?? null,
    })
    .onConflictDoNothing()
    .returning(tagColumns);
  if (created) return { tag: created, created: true };
  const [existing] = await db
    .select(tagColumns)
    .from(tags)
    .where(and(eq(tags.mailboxId, mailboxId), sql`lower(${tags.name}) = lower(${input.name})`));
  return { tag: existing!, created: false };
}

/** Renames or recolors a tag. `conflict` when another tag already has the name. */
export async function updateTag(
  db: Executor,
  memberId: string,
  mailboxId: string,
  tagId: string,
  patch: { name?: string; color?: string | null },
) {
  if (!(await memberSeesMailbox(db, memberId, mailboxId))) return { status: "not_found" as const };
  try {
    const [row] = await db
      .update(tags)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(tags.id, tagId), eq(tags.mailboxId, mailboxId)))
      .returning(tagColumns);
    return row ? { status: "ok" as const, tag: row } : { status: "not_found" as const };
  } catch (error) {
    if (
      (error as { cause?: { code?: string } }).cause?.code === "23505" ||
      (error as { code?: string }).code === "23505"
    ) {
      return { status: "conflict" as const };
    }
    throw error;
  }
}

/** Deletes a tag and removes it from every conversation. False when nothing was deleted. */
export async function deleteTag(db: Executor, memberId: string, mailboxId: string, tagId: string) {
  if (!(await memberSeesMailbox(db, memberId, mailboxId))) return false;
  const rows = await db
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.mailboxId, mailboxId)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

// Internal notes (ADR 0021): in the timeline, never sent, never on IMAP. @mentions notify.

export const NOTE_MAX_LENGTH = 20_000;

/**
 * Adds a note as `memberId`, who must see the conversation. Mentions of members who cannot see
 * the inbox are dropped (they could not open it); each one left is notified once.
 */
export async function createNote(
  db: Executor,
  input: { threadId: string; memberId: string; body: string; mentions: string[] },
) {
  return db.transaction(async (tx) => {
    const locked = await lockConversation(tx, input.threadId, input.memberId);
    if (!locked) return { ok: false as const, reason: "not_found" as const };
    const { kind, ...row } = locked;
    if (kind !== "shared") return { ok: false as const, reason: "personal_mailbox" as const };
    const wanted = [...new Set(input.mentions)];
    const allowed = wanted.length
      ? (
          await tx
            .select({ id: mailboxAccess.memberId })
            .from(mailboxAccess)
            .innerJoin(members, eq(members.id, mailboxAccess.memberId))
            .where(
              and(
                eq(mailboxAccess.mailboxId, row.mailboxId),
                eq(members.organizationId, row.orgId),
                inArray(mailboxAccess.memberId, wanted),
              ),
            )
        ).map((m) => m.id)
      : [];
    const mentions = wanted.filter((m) => allowed.includes(m));
    const [note] = await tx
      .insert(notes)
      .values({
        id: uuidv7(),
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        threadId: row.id,
        authorMemberId: input.memberId,
        body: input.body,
        mentions,
      })
      .returning();
    await writeEvents(tx, row, input.memberId, [{ kind: "note", data: { noteId: note!.id } }]);
    const notified = await notify(tx, row, {
      memberIds: mentions,
      kind: "mention",
      actorMemberId: input.memberId,
      dedupeKey: `mention:${note!.id}`,
      noteId: note!.id,
    });
    return { ok: true as const, note: note!, conversation: row, notified };
  });
}

/**
 * Edits the body of the author's own note. New mentions in the edit are not notified again: an
 * edit is a correction, not a new note. Null when it is not their note or they lost access.
 */
export async function updateNote(
  db: Executor,
  input: { noteId: string; memberId: string; body: string },
) {
  const [row] = await db
    .update(notes)
    .set({ body: input.body, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, input.noteId),
        eq(notes.authorMemberId, input.memberId),
        exists(
          db
            .select({ one: sql`1` })
            .from(mailboxAccess)
            .where(
              and(
                eq(mailboxAccess.mailboxId, notes.mailboxId),
                eq(mailboxAccess.memberId, input.memberId),
              ),
            ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/** Deletes the author's own note (its timeline event and notifications go with it). */
export async function deleteNote(db: Executor, input: { noteId: string; memberId: string }) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(notes)
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.authorMemberId, input.memberId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(mailboxAccess)
              .where(
                and(
                  eq(mailboxAccess.mailboxId, notes.mailboxId),
                  eq(mailboxAccess.memberId, input.memberId),
                ),
              ),
          ),
        ),
      )
      .returning({ id: notes.id, threadId: notes.threadId, mailboxId: notes.mailboxId });
    if (!row) return null;
    await tx
      .delete(conversationEvents)
      .where(
        and(
          eq(conversationEvents.threadId, row.threadId),
          eq(conversationEvents.kind, "note"),
          sql`${conversationEvents.data}->>'noteId' = ${row.id}`,
        ),
      );
    return row;
  });
}

// Notifications: a member's own.

/** Marks the member's notifications read: these ids, or all of them. Returns how many changed. */
export async function markNotificationsRead(db: Executor, memberId: string, ids: string[] | "all") {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.memberId, memberId),
        isNull(notifications.readAt),
        ids === "all" ? undefined : inArray(notifications.id, ids),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
