// Helpdesk conversation workflow (ADR 0021): every change to a shared conversation's status,
// assignee, priority or tags, with its `conversation_events` row, in one transaction. The status
// rules are `nextConversationState` from `@omni/mail-core`; nothing here decides a status itself.
//
// Callers: the Worker's conversation routes (as a member), the `message.created` ingest, the
// reply route (`applyAgentReply`), the AI queue (noise auto-resolve) and the snooze cron. Each
// may run twice, so every function is idempotent: a change that leaves the conversation as it was
// writes no event and queues nothing.
import type { MessageTarget } from "@omni/contracts";
import { nextConversationState, type ConversationEvent } from "@omni/mail-core/conversation-status";
import { and, asc, eq, gt, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { setSlaClocks } from "./sla.ts";
import {
  conversationEvents,
  mailActions,
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  members,
  messageLocations,
  messages,
  tags,
  threadTags,
  threads,
} from "./schema/index.ts";
import {
  type Tx,
  type Executor,
  lockConversation,
  stateOf,
  writeEvents,
  notify,
  type ConversationChange,
  type ChangeResult,
  type ConversationRow,
} from "./conversation-core.ts";
export {
  type ChangeFailure,
  type ChangeResult,
  type ConversationChange,
  type ConversationRow,
  type Executor,
  type NotificationKind,
  PRIORITIES,
  type Priority,
  type Status,
} from "./conversation-core.ts";

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

export interface Applied {
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
export async function applyStatus(
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
    // Resolved: nobody is waiting on us any more (ADR 0023).
    Object.assign(
      updated,
      await setSlaClocks(tx, updated, { responseClockAt: null, resolutionClockAt: null }),
    );
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
export async function assign(
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
        if (
          change.expectedAssignee !== undefined &&
          row.assigneeMemberId !== change.expectedAssignee &&
          row.assigneeMemberId !== change.memberId
        ) {
          return { ok: false, reason: "assignee_changed", conversation: row };
        }
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
        // The new priority's targets apply to the clocks already running.
        applied = {
          row: await setSlaClocks(tx, { ...row, priority: change.priority }),
          changed: true,
          queuedActions: 0,
        };
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
    const answered = await setSlaClocks(tx, responded.row, { responseClockAt: null });
    return {
      ok: true,
      changed: status.changed || claimed.changed || responded.changed,
      conversation: answered,
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
  /** `fresh`: this is the message's first delivery (a personal mailbox, say); false on a replay. */
  | { applied: false; fresh: boolean }
  | {
      applied: true;
      direction: "customer" | "agent";
      changed: boolean;
      conversation: ConversationRow;
      queuedActions: number;
      /** Members who got a new notification: tell them in realtime. */
      notified: string[];
      /** The member auto-assign handed it to (notified as `assigned`), if any. */
      autoAssigned: string | null;
    };

/**
 * The inbox's next member in turn, by member id after the last one handed a conversation, among
 * those who can see the inbox. Null when the inbox does not auto-assign or nobody sees it. The
 * mailbox row lock makes concurrent ingests take turns instead of picking the same member.
 */
async function nextInTurn(tx: Tx, row: ConversationRow) {
  // Most inboxes don't auto-assign: read the flag before taking any lock.
  const [flag] = await tx
    .select({ on: mailboxes.autoAssign })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId));
  if (!flag?.on) return null;
  // "No key update" serializes turns without blocking the key-share locks that inserts referencing
  // the inbox (messages, events) take, so concurrent ingests cannot deadlock on it.
  const [inbox] = await tx
    .select({ on: mailboxes.autoAssign, last: mailboxes.autoAssignLastMemberId })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId))
    .for("no key update");
  if (!inbox?.on) return null;
  const team = (
    await tx
      .select({ id: mailboxAccess.memberId })
      .from(mailboxAccess)
      .innerJoin(
        members,
        and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, row.orgId)),
      )
      .where(eq(mailboxAccess.mailboxId, row.mailboxId))
      .orderBy(asc(mailboxAccess.memberId))
  ).map((m) => m.id);
  if (team.length === 0) return null;
  const last = inbox.last;
  const next = (last !== null && team.find((id) => id > last)) || team[0]!;
  await tx
    .update(mailboxes)
    .set({ autoAssignLastMemberId: next })
    .where(eq(mailboxes.id, row.mailboxId));
  return next;
}

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
    if (!message) return { applied: false, fresh: false };
    const locked = await lockConversation(tx, message.threadId, null);
    if (!locked || locked.kind !== "shared") return { applied: false, fresh: true };
    const [mailbox] = await tx
      .select({ address: mailboxes.address, createdAt: mailboxes.createdAt })
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
      // The customer is waiting from when they wrote (never later than now). Mail sent before the
      // inbox was connected is history: a first sync must not start, and breach, every clock, nor
      // hand the backlog out.
      const live =
        !message.automated && mailbox !== undefined && message.sentAt >= mailbox.createdAt;
      let autoAssigned: string | null = null;
      if (live && applied.row.status === "open" && !applied.row.assigneeMemberId) {
        const next = await nextInTurn(tx, applied.row);
        if (next) {
          const handed = await assign(tx, applied.row, next, null, now, { cause: "auto_assign" });
          applied.row = handed.row;
          if (handed.changed) autoAssigned = next;
        }
      }
      if (live) {
        const since = message.sentAt > now ? now : message.sentAt;
        applied.row = await setSlaClocks(tx, applied.row, {
          responseClockAt: applied.row.responseClockAt ?? since,
          resolutionClockAt: applied.row.resolutionClockAt ?? since,
        });
      }
      // The assignee hears when their customer writes back (not for an auto-reply).
      const notified =
        // (Not when it was just handed to them: they hear `assigned` instead.)
        applied.row.assigneeMemberId && !message.automated && !autoAssigned
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
        autoAssigned,
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
    // Our reply stops the response clock. A late Sent copy answers only what came before it: the
    // customer has been waiting since their first counted message after it.
    const clock = responded.row.responseClockAt;
    let responseClockAt: Date | null = null;
    if (newer && clock && clock >= message.sentAt) responseClockAt = clock;
    else if (newer && mailbox) {
      const [waiting] = await tx
        .select({ sentAt: messages.sentAt })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, row.id),
            gt(messages.sentAt, message.sentAt),
            gte(messages.sentAt, mailbox.createdAt),
            eq(messages.automated, false),
            ne(sql`lower(${messages.fromAddress})`, mailbox.address.toLowerCase()),
          ),
        )
        .orderBy(asc(messages.sentAt))
        .limit(1);
      if (waiting) responseClockAt = waiting.sentAt > now ? now : waiting.sentAt;
    }
    const answered =
      responseClockAt?.getTime() === clock?.getTime()
        ? responded.row
        : await setSlaClocks(tx, responded.row, { responseClockAt });
    return {
      applied: true,
      direction: "agent",
      changed: status.changed || responded.changed,
      conversation: answered,
      queuedActions: status.queuedActions,
      notified: [],
      autoAssigned: null,
    };
  });
}

/**
 * The `discarded` test for the thread `t` (a `threads` alias in the enclosing query): an open,
 * pending or snoozed shared conversation whose mail was all deleted or junked in another mail app
 * (Apple Mail's delete moves to Trash). None of its messages has a copy in INBOX or the archive,
 * one has a copy in Trash or Junk, and that copy arrived after a teammate last changed its
 * status, so a teammate who reopens it in Omni afterwards keeps it open. Status changes Omni made
 * itself (a customer reply that went straight to Junk reopening it) do not count. Our replies in Sent do
 * not count either way. A new message from the customer lands in INBOX and fails the test.
 */
const discarded = sql`t.status <> 'resolved'
  and exists (
    select 1 from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id = t.id and f.role in ('trash', 'junk')
      and l.created_at > coalesce((
        select max(e.created_at) from ${conversationEvents} e
        where e.thread_id = t.id and e.kind = 'status' and e.actor_member_id is not null),
        '-infinity'::timestamptz))
  and not exists (
    select 1 from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id = t.id and f.role in ('inbox', 'archive'))`;

/** Shared conversations of the mailbox that were discarded in another mail app (see above). */
export async function discardedConversations(db: Executor, mailboxId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    select t.id from ${threads} t
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.kind = 'shared'
    where t.mailbox_id = ${mailboxId} and ${discarded}
    order by t.id`)) as unknown as { id: string }[]; // postgres-js: the rows themselves
  return rows.map((r) => r.id);
}

/**
 * Resolves a conversation discarded in another mail app, checking again under the row lock (a
 * teammate may have reopened it since the mail service looked). Nothing moves on IMAP: its mail
 * is already out of INBOX, so the resolve's archive step finds nothing to file. Idempotent.
 */
export async function resolveDiscarded(
  db: Executor,
  input: { threadId: string; now?: Date },
): Promise<{ changed: boolean; conversation: ConversationRow | null }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const locked = await lockConversation(tx, input.threadId, null);
    if (!locked || locked.kind !== "shared") return { changed: false, conversation: null };
    const { kind: _kind, ...row } = locked;
    const still = (await tx.execute(
      sql`select 1 from ${threads} t where t.id = ${row.id} and ${discarded}`,
    )) as unknown as unknown[];
    if (still.length === 0) return { changed: false, conversation: row };
    const applied = await applyStatus(tx, row, { type: "resolve" }, now, null, {
      data: { reason: "discarded_elsewhere" },
    });
    return { changed: applied.changed, conversation: applied.row };
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

/**
 * Turns round-robin auto-assign on or off for a shared inbox of the org. False when there is no
 * such inbox. Turning it on starts with whoever comes first; turning it off forgets the turn.
 */
export async function setAutoAssign(db: Executor, orgId: string, mailboxId: string, on: boolean) {
  const rows = await db
    .update(mailboxes)
    .set({ autoAssign: on, autoAssignLastMemberId: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.orgId, orgId),
        eq(mailboxes.kind, "shared"),
        // Already in that state: keep the turn.
        ne(mailboxes.autoAssign, on),
      ),
    )
    .returning({ id: mailboxes.id });
  if (rows.length) return true;
  const [exists] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId), eq(mailboxes.kind, "shared")),
    );
  return exists !== undefined;
}
