import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { attachments, mailActions, messages, uploads } from "../schema/index.ts";
import { queueMailEvents } from "./pending-mail-events.ts";

/**
 * The files a send attaches, in the order given: uploads made for it and attachments of stored
 * messages (forward), each only if it belongs to `mailboxId`. A missing one is left out; the
 * caller compares counts.
 */
export async function sendAttachmentFiles(
  db: Db,
  mailboxId: string,
  refs: ({ kind: "upload"; uploadId: string } | { kind: "attachment"; attachmentId: string })[],
) {
  const uploadIds = refs.flatMap((r) => (r.kind === "upload" ? [r.uploadId] : []));
  const attachmentIds = refs.flatMap((r) => (r.kind === "attachment" ? [r.attachmentId] : []));
  const fromUploads = uploadIds.length
    ? await db
        .select({
          id: uploads.id,
          filename: uploads.filename,
          mimeType: uploads.mimeType,
          r2Key: uploads.r2Key,
        })
        .from(uploads)
        .where(and(eq(uploads.mailboxId, mailboxId), inArray(uploads.id, uploadIds)))
    : [];
  const fromMessages = attachmentIds.length
    ? await db
        .select({
          id: attachments.id,
          filename: attachments.filename,
          mimeType: attachments.mimeType,
          r2Key: attachments.r2Key,
        })
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(eq(messages.mailboxId, mailboxId), inArray(attachments.id, attachmentIds)))
    : [];
  const byId = new Map([...fromUploads, ...fromMessages].map((f) => [f.id, f]));
  return refs.flatMap((r) => {
    const file = byId.get(r.kind === "upload" ? r.uploadId : r.attachmentId);
    return file ? [{ filename: file.filename, mimeType: file.mimeType, r2Key: file.r2Key }] : [];
  });
}

/** When the next pending outbox action is due (an undo-send window ends), or null. */
export const nextActionDue: (db: Db) => Promise<Date | null> = async (db) => {
  const [row] = await db
    .select({ at: sql<Date | null>`min(${mailActions.runAfter})` })
    .from(mailActions)
    .where(eq(mailActions.status, "pending"));
  return row?.at ? new Date(row.at) : null;
};

/** SMTP accepted a claimed send. Persisted before anything else can fail. */
export async function markActionSmtpAccepted(db: Db, id: string) {
  await db
    .update(mailActions)
    .set({ smtpAcceptedAt: sql`coalesce(${mailActions.smtpAcceptedAt}, now())` })
    .where(eq(mailActions.id, id));
}

/**
 * Records a failed attempt with the caller's retry time, or marks the action `failed` when
 * `retryAt` is null. The caller (the mail service's outbox) owns the backoff policy.
 */
export async function rescheduleAction(db: Db, id: string, error: string, retryAt: Date | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(mailActions)
      .set({
        status: retryAt ? "pending" : "failed",
        runAfter: retryAt ?? sql`${mailActions.runAfter}`,
        lastError: error,
        lockedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mailActions.id, id), eq(mailActions.status, "running")))
      .returning({
        id: mailActions.id,
        orgId: mailActions.orgId,
        mailboxId: mailActions.mailboxId,
        memberId: mailActions.memberId,
        status: mailActions.status,
        requestId: mailActions.requestId,
      });
    if (row?.status === "failed") {
      await queueMailEvents(tx, [
        {
          type: "action.failed",
          orgId: row.orgId,
          mailboxId: row.mailboxId,
          actionId: row.id,
          memberId: row.memberId,
          error,
          requestId: row.requestId,
        },
      ]);
    }
    return row ?? null;
  });
}

/**
 * Hands a claimed action back without counting its attempt: the mailbox was not ready, which says
 * nothing about the action. No-op unless it is still `running` (the lease may have moved on).
 */
export async function deferAction(db: Db, id: string, runAfter: Date) {
  const rows = await db
    .update(mailActions)
    .set({
      status: "pending",
      runAfter,
      attempts: sql`greatest(${mailActions.attempts} - 1, 0)`,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mailActions.id, id), eq(mailActions.status, "running")))
    .returning({ id: mailActions.id });
  return rows.length > 0;
}
