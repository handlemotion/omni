// Hand-off (ADR 0030): a teammate answers a shared conversation from their own personal mailbox,
// and the conversation leaves the team. The send is queued on the personal mailbox, and in the
// same transaction the shared conversation is assigned to the sender, resolved, and gets a
// `handoff` event. Cancelling the send inside its undo window puts the conversation back.
//
// Status changes go through `applyStatus` and `assign` (conversations.ts), so the rules of
// `nextConversationState` hold here too. Both functions are idempotent: a retried request finds
// its send and its event and changes nothing more.
import type { SendAttachment } from "@omni/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { enqueueSendWithAttachments } from "./compose.ts";
import {
  lockConversation,
  type ConversationRow,
  type Status,
  type Tx,
} from "./conversation-core.ts";
import { applyStatus, assign } from "./conversations.ts";
import { conversationEvents } from "../schema/index.ts";
import type { NewMailAction } from "./writers.ts";

/** What a `handoff` event remembers, so a cancelled send can put the conversation back. */
interface HandoffData {
  mailboxId: string;
  address: string;
  actionId: string;
  previous: { status: Status; assigneeMemberId: string | null };
}

const handoffKey = (actionId: string) => `handoff:${actionId}`;

/**
 * Queues the reply on the personal mailbox and hands the shared conversation `threadId` off to
 * `memberId`, in one transaction. The send's `payload.handoffThreadId` must be `threadId`.
 */
export async function enqueueHandoff(
  db: Db,
  input: {
    threadId: string;
    memberId: string;
    send: NewMailAction & { kind: "send" };
    attachments: SendAttachment[];
    delaySeconds: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Locked first, so a teammate's change to the conversation waits for the hand-off or wins.
    const locked = await lockConversation(tx, input.threadId, input.memberId);
    if (!locked) return { ok: false as const, reason: "not_found" as const };
    const { kind, ...row } = locked;
    if (kind !== "shared") return { ok: false as const, reason: "personal_mailbox" as const };
    const queued = await enqueueSendWithAttachments(tx, input.send, input.attachments, {
      delaySeconds: input.delaySeconds,
    });
    // Nothing was written: the attachments are not the personal mailbox's to send.
    if ("invalid" in queued) return { ok: false as const, reason: "invalid_attachments" as const };
    // Only a draft send can find its draft gone, and a hand-off sends no draft.
    if (!("action" in queued)) return { ok: false as const, reason: "not_found" as const };
    const applied = await applyHandoff(tx, row, input.memberId, queued.action.id, input.send, now);
    return { ok: true as const, action: queued.action, ...applied };
  });
}

async function applyHandoff(
  tx: Tx,
  row: ConversationRow,
  memberId: string,
  actionId: string,
  send: NewMailAction,
  now: Date,
) {
  const [written] = await tx
    .insert(conversationEvents)
    .values({
      orgId: row.orgId,
      mailboxId: row.mailboxId,
      threadId: row.id,
      actorMemberId: memberId,
      kind: "handoff",
      data: {
        mailboxId: send.mailboxId,
        address: (send.payload as { from: string }).from,
        actionId,
        previous: { status: row.status, assigneeMemberId: row.assigneeMemberId },
      } satisfies HandoffData,
      dedupeKey: handoffKey(actionId),
    })
    .onConflictDoNothing()
    .returning({ id: conversationEvents.id });
  // A retry of the same request: the hand-off is already applied, and a teammate may have
  // changed the conversation since. Leave it.
  if (!written) return { conversation: row, changed: false, queuedActions: 0 };
  const cause = { cause: "handoff" };
  const assigned = await assign(tx, row, memberId, memberId, now, cause);
  const resolved = await applyStatus(tx, assigned.row, { type: "resolve" }, now, memberId, {
    requestId: send.requestId ?? undefined,
    data: cause,
  });
  return { conversation: resolved.row, changed: true, queuedActions: resolved.queuedActions };
}

/**
 * The send of a hand-off was cancelled (inside `cancelSend`'s transaction): the conversation goes
 * back to the team, reopened and with its previous assignee, unless someone changed it since
 * the hand-off (it is no longer resolved, or no longer the sender's). A send never sent answered
 * nobody, so it reopens to `open` whatever it was before (`pending` or `snoozed` included).
 */
export async function undoHandoff(
  tx: Tx,
  input: { threadId: string; actionId: string; memberId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const locked = await lockConversation(tx, input.threadId, null);
  if (!locked || locked.kind !== "shared") return null;
  const { kind: _kind, ...row } = locked;
  const [event] = await tx
    .select({ data: conversationEvents.data, actor: conversationEvents.actorMemberId })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.threadId, row.id),
        eq(conversationEvents.dedupeKey, handoffKey(input.actionId)),
      ),
    );
  if (!event || event.actor !== input.memberId) return null;
  if (row.status !== "resolved" || row.assigneeMemberId !== input.memberId) {
    return { conversation: row, changed: false, queuedActions: 0, notified: [] as string[] };
  }
  const { previous } = event.data as unknown as HandoffData;
  const cause = { cause: "handoff_cancelled" };
  const reopened =
    previous.status === "resolved"
      ? { row, changed: false, queuedActions: 0 }
      : await applyStatus(tx, row, { type: "reopen" }, now, input.memberId, {
          data: cause,
          dedupeKey: `handoff_cancelled:${input.actionId}`,
        });
  const reassigned = await assign(
    tx,
    reopened.row,
    previous.assigneeMemberId,
    input.memberId,
    now,
    cause,
  );
  return {
    conversation: reassigned.row,
    changed: reopened.changed || reassigned.changed,
    queuedActions: reopened.queuedActions,
    /** Whoever had it before and got an `assigned` notification back: tell them in realtime. */
    notified: reassigned.notified ?? [],
  };
}
