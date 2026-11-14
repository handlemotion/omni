// Shared drafts and undo send (ADR 0021). Drafts live in Postgres only, shared with everyone on
// the inbox; `version` makes a stale autosave fail instead of overwriting a teammate's newer one.
// A send waits in the outbox for the member's undo window (`run_after`), and cancelling deletes
// the row before the mail service can claim it.
import { and, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { memberMailbox } from "./compose.ts";
import { undoHandoff } from "./handoff.ts";
import { grantFor } from "./member-mail.ts";
import {
  drafts,
  mailActions,
  memberPreferences,
  messages,
  threads,
  uploads,
  type Address,
  type DraftAttachment,
} from "./schema/index.ts";
import type { MailActionRequest } from "./writers.ts";

/** The member's undo-send window in seconds: their preference, else 5 (Rodrigo, Nov 12). */
export async function undoSendSeconds(db: Db, memberId: string) {
  const [row] = await db
    .select({ seconds: memberPreferences.undoSendSeconds })
    .from(memberPreferences)
    .where(eq(memberPreferences.memberId, memberId));
  return row?.seconds ?? 5;
}

/**
 * Cancels the member's own send if the mail service has not claimed it: deletes the outbox row
 * and frees its uploads for another send. A hand-off's send (ADR 0030) also puts its shared
 * conversation back, in the same transaction (`handoff`: what changed there). Returns the
 * payload so the composer can be restored, `"too_late"` once it is claimed or done, or null when
 * there is no such send of theirs.
 */
export async function cancelSend(db: Db, memberId: string, actionId: string) {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(mailActions)
      .where(
        and(
          eq(mailActions.id, actionId),
          eq(mailActions.memberId, memberId),
          eq(mailActions.kind, "send"),
          eq(mailActions.status, "pending"),
          eq(mailActions.attempts, 0),
          isNull(mailActions.smtpAcceptedAt),
        ),
      )
      .returning({ payload: mailActions.payload });
    if (!deleted) {
      const [exists] = await tx
        .select({ id: mailActions.id })
        .from(mailActions)
        .where(
          and(
            eq(mailActions.id, actionId),
            eq(mailActions.memberId, memberId),
            eq(mailActions.kind, "send"),
          ),
        );
      return exists ? ("too_late" as const) : null;
    }
    const payload = deleted.payload as Extract<MailActionRequest, { kind: "send" }>["payload"];
    const uploadIds = (payload.attachments ?? []).flatMap((a) =>
      a.kind === "upload" ? [a.uploadId] : [],
    );
    if (uploadIds.length) {
      // Back to unsent, with a fresh day before the cleanup takes them.
      await tx
        .update(uploads)
        .set({
          usedAt: null,
          expiresAt: sql`greatest(${uploads.expiresAt}, now() + interval '1 day')`,
        })
        .where(inArray(uploads.id, uploadIds));
    }
    const handoff = payload.handoffThreadId
      ? await undoHandoff(tx, { threadId: payload.handoffThreadId, actionId, memberId })
      : null;
    return { payload, handoff };
  });
}

const draftColumns = {
  id: drafts.id,
  mailboxId: drafts.mailboxId,
  threadId: drafts.threadId,
  kind: drafts.kind,
  sourceMessageId: drafts.sourceMessageId,
  authorMemberId: drafts.authorMemberId,
  updatedByMemberId: drafts.updatedByMemberId,
  to: drafts.to,
  cc: drafts.cc,
  bcc: drafts.bcc,
  subject: drafts.subject,
  bodyText: drafts.bodyText,
  bodyHtml: drafts.bodyHtml,
  attachments: drafts.attachments,
  version: drafts.version,
  createdAt: drafts.createdAt,
  updatedAt: drafts.updatedAt,
};

export interface DraftContent {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: DraftAttachment[];
}

/** Drafts of one inbox, or of one conversation, newest first. Empty when the member can't see it. */
export async function listDrafts(
  db: Db,
  memberId: string,
  filter: { mailboxId?: string; threadId?: string },
) {
  return db
    .select(draftColumns)
    .from(drafts)
    .where(
      and(
        filter.mailboxId ? eq(drafts.mailboxId, filter.mailboxId) : undefined,
        filter.threadId ? eq(drafts.threadId, filter.threadId) : undefined,
        exists(grantFor(db, memberId, drafts.mailboxId, drafts.orgId)),
      ),
    )
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(100);
}

export async function getDraft(db: Db, memberId: string, id: string) {
  const [row] = await db
    .select(draftColumns)
    .from(drafts)
    .where(and(eq(drafts.id, id), exists(grantFor(db, memberId, drafts.mailboxId, drafts.orgId))));
  return row ?? null;
}

/**
 * Starts a draft. A reply or forward names its conversation and source message, which must be in
 * the same inbox. Null when the member can't see the inbox, thread or message.
 */
export async function createDraft(
  db: Db,
  memberId: string,
  input: Partial<DraftContent> & {
    mailboxId: string;
    kind: "new" | "reply" | "forward";
    threadId?: string | null;
    sourceMessageId?: string | null;
  },
) {
  const mailbox = await memberMailbox(db, memberId, input.mailboxId);
  if (!mailbox) return null;
  if (input.kind !== "new") {
    if (!input.threadId) return null;
    const [thread] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, input.threadId), eq(threads.mailboxId, input.mailboxId)));
    if (!thread) return null;
    if (input.sourceMessageId) {
      const [message] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, input.sourceMessageId), eq(messages.threadId, thread.id)));
      if (!message) return null;
    }
  }
  const [row] = await db
    .insert(drafts)
    .values({
      orgId: mailbox.orgId,
      mailboxId: input.mailboxId,
      threadId: input.kind === "new" ? null : input.threadId,
      kind: input.kind,
      sourceMessageId: input.kind === "new" ? null : (input.sourceMessageId ?? null),
      authorMemberId: memberId,
      updatedByMemberId: memberId,
      to: input.to ?? [],
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject ?? "",
      bodyText: input.bodyText ?? "",
      bodyHtml: input.bodyHtml ?? null,
      attachments: input.attachments ?? [],
    })
    .returning(draftColumns);
  return row!;
}

/**
 * Saves a draft if it is still at `version` (the one the editor loaded), bumping the version.
 * `"conflict"` with the current draft when a teammate saved first; null when it's gone.
 */
export async function saveDraft(
  db: Db,
  memberId: string,
  id: string,
  version: number,
  content: Partial<DraftContent>,
) {
  const [row] = await db
    .update(drafts)
    .set({
      ...content,
      updatedByMemberId: memberId,
      version: sql`${drafts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(drafts.id, id),
        eq(drafts.version, version),
        exists(grantFor(db, memberId, drafts.mailboxId, drafts.orgId)),
      ),
    )
    .returning(draftColumns);
  if (row) return { draft: row };
  const current = await getDraft(db, memberId, id);
  return current ? { conflict: current } : null;
}

export async function deleteDraft(db: Db, memberId: string, id: string) {
  const rows = await db
    .delete(drafts)
    .where(and(eq(drafts.id, id), exists(grantFor(db, memberId, drafts.mailboxId, drafts.orgId))))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** The member's send queued under `idempotencyKey`, for a retried draft send. */
export async function memberSendByKey(db: Db, memberId: string, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(mailActions)
    .where(and(eq(mailActions.idempotencyKey, idempotencyKey), eq(mailActions.memberId, memberId)));
  return row ?? null;
}
