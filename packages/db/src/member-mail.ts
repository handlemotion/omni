// Member-scoped reads and writes the API's mail actions need, beside `forMember`. Like it, every
// query inner-joins `mailbox_access` for this member and `members` for the row's org, so a
// missing grant or a grant that crosses orgs finds nothing.
import { and, asc, eq, exists, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  mailboxAccess,
  mailboxFolders,
  mailboxes,
  messageLocations,
  members,
  messages,
  threads,
} from "./schema/index.ts";

function grantFor(db: Db, memberId: string, mailboxId: AnyColumn, orgId: AnyColumn) {
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
export async function threadActionTargets(db: Db, memberId: string, threadId: string) {
  const [thread] = await db
    .select({
      id: threads.id,
      orgId: threads.orgId,
      mailboxId: threads.mailboxId,
      mailboxKind: mailboxes.kind,
      mailboxAddress: mailboxes.address,
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
    .where(and(eq(messages.threadId, thread.id), isNotNull(mailboxFolders.uidvalidity)))
    .orderBy(asc(mailboxFolders.path), asc(messageLocations.imapUid));

  // Same shape as `messageTargetSchema` in @omni/contracts, plus the folder role.
  const byFolder = new Map<
    string,
    { folder: string; uidValidity: string; uids: number[]; role: string }
  >();
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
