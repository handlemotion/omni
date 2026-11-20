import type { MessageTarget } from "@omni/contracts";
import { and, asc, desc, eq, exists, isNotNull, lte, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor } from "./conversation-core.ts";
import {
  attachments,
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  messageLocations,
  members,
  messages,
  threads,
  triageBucket,
  triageFeedback,
} from "../schema/index.ts";

/** `exists` subquery: `memberId` has a grant on the row's mailbox, in the row's org. */
export function grantFor(db: Db, memberId: string, mailboxId: AnyColumn, orgId: AnyColumn) {
  return db
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
}

/** Mailboxes this member can see. Never includes `credentials_enc`. */
export async function listMemberMailboxes(db: Db, memberId: string) {
  return db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      status: mailboxes.status,
      role: mailboxAccess.role,
      label: mailboxes.label,
      picture: mailboxes.picture,
    })
    .from(mailboxes)
    .innerJoin(
      mailboxAccess,
      and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.memberId, memberId)),
    )
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .orderBy(asc(mailboxes.address));
}

/**
 * The thread's mailbox and every IMAP copy of its messages (`message_locations`) grouped by
 * folder, ready to become outbox payloads. A message in two folders is targeted in both; one not
 * yet in any folder (a send before its Sent append) is left out.
 * Null when the member cannot see the thread.
 */
export async function threadActionTargets(
  db: Db,
  memberId: string,
  threadId: string,
  only?: "newest" | Date,
) {
  const [thread] = await db
    .select({
      id: threads.id,
      orgId: threads.orgId,
      mailboxId: threads.mailboxId,
      mailboxKind: mailboxes.kind,
      mailboxProvider: mailboxes.provider,
      mailboxAddress: mailboxes.address,
      lastMessageAt: threads.lastMessageAt,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(threads.id, threadId),
        exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
      ),
    );
  if (!thread) return null;

  const rows = await db
    .select({
      folder: mailboxFolders.path,
      role: mailboxFolders.role,
      uidValidity: mailboxFolders.uidvalidity,
      uid: messageLocations.imapUid,
    })
    .from(messageLocations)
    .innerJoin(messages, eq(messages.id, messageLocations.messageId))
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .where(
      and(
        eq(messages.threadId, thread.id),
        isNotNull(mailboxFolders.uidvalidity),
        only === "newest" ? eq(messages.sentAt, thread.lastMessageAt) : undefined,
        only instanceof Date ? lte(messages.sentAt, only) : undefined,
      ),
    )
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
  return { ...thread, targets: [...byFolder.values()] };
}

/**
 * Sets `threads.archived` so every member's app updates before the mail service has moved the
 * mail. The next sync confirms it. Returns false when the member cannot see the thread.
 */
export async function setThreadArchived(
  db: Db,
  memberId: string,
  threadId: string,
  archived: boolean,
) {
  const rows = await db
    .update(threads)
    .set({ archived, updatedAt: new Date() })
    .where(
      and(
        eq(threads.id, threadId),
        exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
      ),
    )
    .returning({ id: threads.id });
  return rows.length > 0;
}

/**
 * An attachment by the content hash the mail service names it with (the last segment of
 * `attachments.r2_key`, as linked from sanitized HTML), if the member can see its message.
 */
export async function findMemberAttachmentByHash(db: Db, memberId: string, sha256: string) {
  const [row] = await db
    .select({
      r2Key: attachments.r2Key,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        sql`split_part(${attachments.r2Key}, '/att/', 2) = ${sha256}`,
        exists(grantFor(db, memberId, messages.mailboxId, messages.orgId)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * One attachment by id, if the member can see its message: the same grant as
 * `findMemberAttachmentByHash`, for routes that name an attachment (save to drive).
 */
export async function findMemberAttachment(db: Db, memberId: string, attachmentId: string) {
  const [row] = await db
    .select({
      id: attachments.id,
      orgId: attachments.orgId,
      r2Key: attachments.r2Key,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      size: attachments.size,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        exists(grantFor(db, memberId, messages.mailboxId, messages.orgId)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Where one message's sanitized HTML is stored (`messages.html_r2_key`), if it is in `threadId`
 * and the member can see it. One indexed read, not the whole thread.
 */
export async function findMemberMessageHtml(
  db: Db,
  memberId: string,
  threadId: string,
  messageId: string,
) {
  const [row] = await db
    .select({ htmlR2Key: messages.htmlR2Key })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.threadId, threadId),
        exists(grantFor(db, memberId, messages.mailboxId, messages.orgId)),
      ),
    )
    .limit(1);
  return row?.htmlR2Key ?? null;
}

async function resortLanded(tx: Executor, memberId: string, threadId: string, requestKey: string) {
  const [seen] = await tx
    .select({ id: triageFeedback.id })
    .from(triageFeedback)
    .where(
      and(
        eq(triageFeedback.memberId, memberId),
        eq(triageFeedback.threadId, threadId),
        eq(triageFeedback.requestKey, requestKey),
      ),
    )
    .limit(1);
  return Boolean(seen);
}

/**
 * A person files a thread in `lane` (an agent's `triage` does it for them): the triage
 * becomes theirs (`triage_source = person`, which always files), describes the thread's latest
 * message so a newer one re-triages it, and the re-sort is kept in `triage_feedback` to tune the
 * model. Reaffirming the person's lane after new mail only moves the marker to that mail. Returns
 * the thread's mailbox and whether the thread was written, or null when the member cannot see it.
 * A retry under a `requestKey` whose re-sort already landed writes nothing, so it cannot undo a
 * teammate's re-sort made in between.
 */
export async function resortThread(
  db: Db,
  memberId: string,
  threadId: string,
  lane: (typeof triageBucket.enumValues)[number],
  requestKey?: string,
) {
  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select({
        orgId: threads.orgId,
        mailboxId: threads.mailboxId,
        triage: threads.triage,
        triageSource: threads.triageSource,
        triageMessageId: threads.triageMessageId,
      })
      .from(threads)
      .where(
        and(
          eq(threads.id, threadId),
          exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
        ),
      )
      .for("update");
    if (!thread) return null;
    const result = { mailboxId: thread.mailboxId, changed: true };
    if (requestKey && (await resortLanded(tx, memberId, threadId, requestKey))) {
      return { ...result, changed: false };
    }
    const [newest] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(1);
    const latest = newest?.id ?? null;
    const sameChoice = thread.triage === lane && thread.triageSource === "person";
    if (sameChoice && thread.triageMessageId === latest) return { ...result, changed: false };
    await tx
      .update(threads)
      .set({
        triage: lane,
        triageSource: "person",
        triageConfidence: 1,
        triageMessageId: latest,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, threadId));
    if (sameChoice) return result;
    await tx.insert(triageFeedback).values({
      orgId: thread.orgId,
      threadId,
      memberId,
      fromBucket: thread.triage,
      toBucket: lane,
      requestKey,
    });
    return result;
  });
}
