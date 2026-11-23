import { and, eq, sql } from "drizzle-orm";
import {
  conversationEvents,
  mailboxAccess,
  members,
  tags,
  threadTags,
  threads,
} from "../schema/index.ts";
import {
  lockSharedConversation,
  writeEvents,
  type ChangeFailure,
  type ChangeResult,
  type ConversationChange,
  type ConversationRow,
  type Executor,
  type Tx,
} from "./conversation-core.ts";
import {
  applyStatus,
  assign,
  recordFirstResponse,
  unchanged,
  type Applied,
} from "./conversation-steps.ts";
import { grantInOrg } from "./grants.ts";
import { setSlaClocks } from "./sla.ts";

interface ChangeContext {
  tx: Tx;
  row: ConversationRow;
  actorMemberId: string | null;
  now: Date;
  requestId?: string;
  dedupeKey?: string;
}

type Outcome = Applied | { failed: ChangeFailure; conversation?: ConversationRow };

const fail = (failed: ChangeFailure, conversation?: ConversationRow) =>
  ({ failed, conversation }) satisfies Outcome;

const sourceOf = (source: "ai" | undefined) => (source ? { source } : {});

async function canSee(tx: Tx, memberId: string, mailboxId: string, orgId: string) {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(mailboxAccess)
    .innerJoin(members, grantInOrg(orgId))
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.memberId, memberId)));
  return row !== undefined;
}

async function changeAssignee(
  ctx: ChangeContext,
  change: Extract<ConversationChange, { type: "assign" }>,
) {
  const { tx, row } = ctx;
  if (
    change.expectedAssignee !== undefined &&
    row.assigneeMemberId !== change.expectedAssignee &&
    row.assigneeMemberId !== change.memberId
  ) {
    return fail("assignee_changed", row);
  }
  if (change.memberId && !(await canSee(tx, change.memberId, row.mailboxId, row.orgId))) {
    return fail("not_assignable");
  }
  return assign(
    tx,
    row,
    change.memberId,
    ctx.actorMemberId,
    ctx.now,
    sourceOf(change.source),
    ctx.dedupeKey,
  );
}

async function changePriority(
  { tx, row, actorMemberId, now, dedupeKey }: ChangeContext,
  change: Extract<ConversationChange, { type: "priority" }>,
) {
  if (row.priority === change.priority) return unchanged(row);
  await tx
    .update(threads)
    .set({ priority: change.priority, updatedAt: now })
    .where(eq(threads.id, row.id));
  await writeEvents(tx, row, actorMemberId, [
    {
      kind: "priority",
      data: { from: row.priority, to: change.priority, ...sourceOf(change.source) },
      dedupeKey,
    },
  ]);
  return {
    row: await setSlaClocks(tx, { ...row, priority: change.priority }),
    changed: true,
    queuedActions: 0,
  } satisfies Applied;
}

async function changeTag(
  { tx, row, actorMemberId, now, dedupeKey }: ChangeContext,
  change: Extract<ConversationChange, { type: "tag" }>,
) {
  const [tag] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, change.tagId), eq(tags.mailboxId, row.mailboxId)));
  if (!tag) return fail("unknown_tag");
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
        data: { tagId: tag.id, ...sourceOf(change.source) },
        dedupeKey,
      },
    ]);
  }
  return { row, changed: touched.length > 0, queuedActions: 0 } satisfies Applied;
}

function applyChange(ctx: ChangeContext, change: ConversationChange) {
  const { tx, row, now, actorMemberId } = ctx;
  const keys = { requestId: ctx.requestId, dedupeKey: ctx.dedupeKey };
  switch (change.type) {
    case "resolve":
      return applyStatus(tx, row, { type: "resolve" }, now, actorMemberId, {
        ...keys,
        data: change.reason ? { reason: change.reason } : undefined,
      });
    case "reopen":
      return applyStatus(tx, row, { type: "reopen" }, now, actorMemberId, keys);
    case "snooze":
      if (change.until.getTime() <= now.getTime()) return fail("invalid_snooze");
      return applyStatus(tx, row, change, now, actorMemberId, keys);
    case "snooze_expired":
      return applyStatus(tx, row, change, now, actorMemberId);
    case "assign":
      return changeAssignee(ctx, change);
    case "priority":
      return changePriority(ctx, change);
    case "tag":
      return changeTag(ctx, change);
  }
}

async function seenRequest(tx: Tx, threadId: string, dedupeKey: string | undefined) {
  if (!dedupeKey) return false;
  const [seen] = await tx
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.threadId, threadId), eq(conversationEvents.dedupeKey, dedupeKey)),
    );
  return seen !== undefined;
}

function resultOf(outcome: Outcome) {
  const result: ChangeResult =
    "failed" in outcome
      ? outcome.conversation
        ? { ok: false, reason: outcome.failed, conversation: outcome.conversation }
        : { ok: false, reason: outcome.failed }
      : {
          ok: true,
          changed: outcome.changed,
          conversation: outcome.row,
          queuedActions: outcome.queuedActions,
          notified: outcome.notified ?? [],
        };
  return result;
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
) {
  const { threadId, actorMemberId } = input;
  const now = input.now ?? new Date();
  const dedupeKey = input.idempotencyKey
    ? `request:${actorMemberId ?? "system"}:${input.idempotencyKey}`
    : undefined;
  return db.transaction<ChangeResult>(async (tx) => {
    const locked = await lockSharedConversation(tx, threadId, actorMemberId);
    if (!locked.ok) return { ok: false, reason: locked.reason };
    const { row } = locked;
    if (await seenRequest(tx, row.id, dedupeKey)) return resultOf(unchanged(row));
    const ctx: ChangeContext = {
      tx,
      row,
      actorMemberId,
      now,
      requestId: input.requestId,
      dedupeKey,
    };
    return resultOf(await applyChange(ctx, input.change));
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
) {
  const now = input.now ?? new Date();
  return db.transaction<ChangeResult>(async (tx) => {
    const locked = await lockSharedConversation(tx, input.threadId, input.memberId);
    if (!locked.ok) return { ok: false, reason: locked.reason };
    const { row } = locked;
    const status = await applyStatus(tx, row, { type: "agent_reply" }, now, input.memberId);
    const claimed = row.assigneeMemberId
      ? { row: status.row, changed: false }
      : await assign(tx, status.row, input.memberId, input.memberId, now, { cause: "first_reply" });
    const responded = await recordFirstResponse(tx, claimed.row, input.memberId, now);
    const answered = await setSlaClocks(tx, responded.row, { responseClockAt: null });
    const result: ChangeResult = {
      ok: true,
      changed: status.changed || claimed.changed || responded.changed,
      conversation: answered,
      queuedActions: status.queuedActions,
      notified: [],
    };
    return result;
  });
}
