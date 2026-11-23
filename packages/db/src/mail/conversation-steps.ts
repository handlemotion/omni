import type { MessageTarget } from "@omni/contracts";
import { nextConversationState, type ConversationEvent } from "@omni/mail-core/conversation-status";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  mailActions,
  mailboxFolders,
  messageLocations,
  messages,
  threads,
} from "../schema/index.ts";
import {
  notify,
  stateOf,
  writeEvents,
  type ConversationRow,
  type Tx,
} from "./conversation-core.ts";
import { setSlaClocks } from "./sla.ts";

/**
 * How long a resolve waits before its archive runs. Reopening inside it cancels the archive, so
 * an undo never has to move mail back. Reopening later moves the archived copies back to INBOX.
 */
export const ARCHIVE_DELAY_SECONDS = 10;

export interface Applied {
  row: ConversationRow;
  changed: boolean;
  queuedActions: number;
  /** Members who got a new notification from this change. */
  notified?: string[];
}

/** No change to `row`: what a step returns when there is nothing to do. */
export function unchanged(row: ConversationRow) {
  return { row, changed: false, queuedActions: 0 } satisfies Applied;
}

type FolderRole = (typeof mailboxFolders.$inferSelect)["role"];
type FolderTarget = MessageTarget & { role: FolderRole };
type FilingAction = { kind: "archive" | "move"; payload: Record<string, unknown>; folder: string };

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
  const byFolder = new Map<string, FolderTarget>();
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

function archiveActions(targets: FolderTarget[]) {
  return targets
    .filter((t) => t.role === "inbox")
    .map(({ role: _role, ...target }) => ({
      kind: "archive" as const,
      payload: target,
      folder: target.folder,
    })) satisfies FilingAction[];
}

async function unarchiveActions(tx: Tx, row: ConversationRow, targets: FolderTarget[]) {
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
  const [inbox] = await tx
    .select({ path: mailboxFolders.path })
    .from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, row.mailboxId), eq(mailboxFolders.role, "inbox")))
    .limit(1);
  if (!inbox) return [] satisfies FilingAction[];
  return targets
    .filter((t) => t.role === "archive")
    .map(({ role: _role, ...target }) => ({
      kind: "move" as const,
      payload: { ...target, destination: inbox.path },
      folder: target.folder,
    })) satisfies FilingAction[];
}

async function fileMail(
  tx: Tx,
  row: ConversationRow,
  actorMemberId: string | null,
  direction: "archive" | "unarchive",
  event: { id: string; requestId: string | undefined },
) {
  await tx
    .update(threads)
    .set({ archived: direction === "archive", updatedAt: new Date() })
    .where(eq(threads.id, row.id));
  const targets = await folderTargets(tx, row.id);
  const actions: FilingAction[] =
    direction === "archive" ? archiveActions(targets) : await unarchiveActions(tx, row, targets);
  if (actions.length === 0) return 0;
  const runAfter = new Date(Date.now() + ARCHIVE_DELAY_SECONDS * 1000);
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
        idempotencyKey: `conversation:${row.id}:${event.id}:${action.kind}:${action.folder}`,
        requestId: event.requestId ?? null,
        runAfter: action.kind === "archive" ? runAfter : undefined,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: mailActions.id });
  return inserted.length;
}

function filingDirection(from: ConversationRow["status"], to: ConversationRow["status"]) {
  if (to === "resolved" && from !== "resolved") return "archive" as const;
  if (from === "resolved" && to !== "resolved") return "unarchive" as const;
  return null;
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
) {
  const next = nextConversationState(stateOf(row), event, now);
  if (!next.changed) return unchanged(row);
  const { status, snoozedUntil, resolvedAt } = next.state;
  const updated = { ...row, status, snoozedUntil, resolvedAt };
  await tx
    .update(threads)
    .set({ status, snoozedUntil, resolvedAt, updatedAt: now })
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
  if (!written) return unchanged(row);
  const direction = filingDirection(row.status, updated.status);
  if (direction === "archive") {
    Object.assign(
      updated,
      await setSlaClocks(tx, updated, { responseClockAt: null, resolutionClockAt: null }),
    );
  }
  const queuedActions = direction
    ? await fileMail(tx, updated, actorMemberId, direction, {
        id: written.id,
        requestId: options.requestId,
      })
    : 0;
  const result: Applied = { row: updated, changed: true, queuedActions };
  return result;
}

/** Sets the assignee and writes the `assigned` event. */
export const assign: (
  tx: Tx,
  row: ConversationRow,
  memberId: string | null,
  actorMemberId: string | null,
  now: Date,
  data?: Record<string, unknown>,
  dedupeKey?: string,
) => Promise<Applied> = async (tx, row, memberId, actorMemberId, now, data = {}, dedupeKey) => {
  if (row.assigneeMemberId === memberId) return unchanged(row);
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
};

/** Records the conversation's first response at `at`, once. */
export async function recordFirstResponse(
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
