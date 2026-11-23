import { and, asc, eq, gt, gte, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { mailboxes, messages } from "../schema/index.ts";
import { nextInTurn } from "./auto-assign.ts";
import {
  lockSharedConversation,
  notify,
  type ConversationRow,
  type Executor,
  type Tx,
} from "./conversation-core.ts";
import { applyStatus, assign, recordFirstResponse, unchanged } from "./conversation-steps.ts";
import { setSlaClocks } from "./sla.ts";

export type InboundResult =
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

interface Inbound {
  id: string;
  fromAddress: string;
  automated: boolean;
  sentAt: Date;
}

type Mailbox = { address: string; createdAt: Date } | undefined;

const earliest = (at: Date, now: Date) => (at > now ? now : at);

async function autoAssignOpen(tx: Tx, row: ConversationRow, now: Date) {
  if (row.status !== "open" || row.assigneeMemberId) return { row, autoAssigned: null };
  const next = await nextInTurn(tx, row);
  if (!next) return { row, autoAssigned: null };
  const handed = await assign(tx, row, next, null, now, { cause: "auto_assign" });
  return { row: handed.row, autoAssigned: handed.changed ? next : null };
}

async function applyCustomerMessage(
  tx: Tx,
  row: ConversationRow,
  message: Inbound,
  mailbox: Mailbox,
  now: Date,
) {
  const applied = await applyStatus(
    tx,
    row,
    { type: "customer_message", automated: message.automated },
    now,
    null,
    { data: { messageId: message.id } },
  );
  const live = !message.automated && mailbox !== undefined && message.sentAt >= mailbox.createdAt;
  let current = applied.row;
  let autoAssigned: string | null = null;
  if (live) {
    ({ row: current, autoAssigned } = await autoAssignOpen(tx, current, now));
    const since = earliest(message.sentAt, now);
    current = await setSlaClocks(tx, current, {
      responseClockAt: current.responseClockAt ?? since,
      resolutionClockAt: current.resolutionClockAt ?? since,
    });
  }
  const notified =
    current.assigneeMemberId && !message.automated && !autoAssigned
      ? await notify(tx, current, {
          memberIds: [current.assigneeMemberId],
          kind: "customer_reply",
          actorMemberId: null,
          dedupeKey: `customer_reply:${message.id}`,
          data: { messageId: message.id },
        })
      : [];
  const result: InboundResult = {
    applied: true,
    direction: "customer",
    changed: applied.changed,
    conversation: current,
    queuedActions: applied.queuedActions,
    notified,
    autoAssigned,
  };
  return result;
}

async function firstMessageWhere(tx: Tx, threadId: string, where: SQL | undefined) {
  const [row] = await tx
    .select({ id: messages.id, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), where))
    .orderBy(asc(messages.sentAt))
    .limit(1);
  return row;
}

async function clockAfterOlderReply(
  tx: Tx,
  row: ConversationRow,
  message: Inbound,
  mailbox: Mailbox,
  now: Date,
) {
  const clock = row.responseClockAt;
  if (clock && clock >= message.sentAt) return clock;
  if (!mailbox) return null;
  const waiting = await firstMessageWhere(
    tx,
    row.id,
    and(
      gt(messages.sentAt, message.sentAt),
      gte(messages.sentAt, mailbox.createdAt),
      eq(messages.automated, false),
      ne(sql`lower(${messages.fromAddress})`, mailbox.address.toLowerCase()),
    ),
  );
  return waiting ? earliest(waiting.sentAt, now) : null;
}

async function applyOurMessage(
  tx: Tx,
  row: ConversationRow,
  message: Inbound,
  mailbox: Mailbox,
  now: Date,
) {
  const notOurs = ne(sql`lower(${messages.fromAddress})`, (mailbox?.address ?? "").toLowerCase());
  const newer = await firstMessageWhere(
    tx,
    row.id,
    and(gt(messages.sentAt, message.sentAt), eq(messages.automated, false), notOurs),
  );
  const status = newer
    ? unchanged(row)
    : await applyStatus(tx, row, { type: "agent_reply" }, now, null, {
        data: { messageId: message.id },
      });
  const earlierAsk = await firstMessageWhere(
    tx,
    row.id,
    and(lte(messages.sentAt, message.sentAt), notOurs),
  );
  const responded = earlierAsk
    ? await recordFirstResponse(tx, status.row, null, message.sentAt, { messageId: message.id })
    : { row: status.row, changed: false };
  const clock = responded.row.responseClockAt;
  const responseClockAt = newer
    ? await clockAfterOlderReply(tx, responded.row, message, mailbox, now)
    : null;
  const answered =
    responseClockAt?.getTime() === clock?.getTime()
      ? responded.row
      : await setSlaClocks(tx, responded.row, { responseClockAt });
  const result: InboundResult = {
    applied: true,
    direction: "agent",
    changed: status.changed || responded.changed,
    conversation: answered,
    queuedActions: status.queuedActions,
    notified: [],
    autoAssigned: null,
  };
  return result;
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
) {
  const now = input.now ?? new Date();
  return db.transaction<InboundResult>(async (tx) => {
    const [claimed] = await tx
      .update(messages)
      .set({ workflowAppliedAt: now })
      .where(and(eq(messages.id, input.messageId), isNull(messages.workflowAppliedAt)))
      .returning({
        threadId: messages.threadId,
        fromAddress: messages.fromAddress,
        automated: messages.automated,
        sentAt: messages.sentAt,
      });
    if (!claimed) return { applied: false, fresh: false };
    const locked = await lockSharedConversation(tx, claimed.threadId, null);
    if (!locked.ok) return { applied: false, fresh: true };
    const { row } = locked;
    const [mailbox] = await tx
      .select({ address: mailboxes.address, createdAt: mailboxes.createdAt })
      .from(mailboxes)
      .where(eq(mailboxes.id, row.mailboxId));
    const message = { ...claimed, id: input.messageId };
    const ours =
      input.folderRole === "sent" ||
      message.fromAddress.toLowerCase() === mailbox?.address.toLowerCase();
    return ours
      ? applyOurMessage(tx, row, message, mailbox, now)
      : applyCustomerMessage(tx, row, message, mailbox, now);
  });
}
