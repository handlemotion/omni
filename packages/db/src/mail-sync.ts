// Mail service writers for IMAP sync: folders, sync positions, message locations, mailboxes and
// outbox bookkeeping. Like `writers.ts`, only trusted background code calls these, and each one
// is idempotent so a repeated sync step converges.
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  mailActions,
  mailboxAccess,
  mailboxes,
  mailboxFolders,
  members,
  messageLocations,
  messages,
  threads,
  users,
} from "./schema/index.ts";

type FolderRole = (typeof mailboxFolders.$inferSelect)["role"];

export interface FolderPosition {
  uidvalidity: number;
  uidnext: number;
  highestModseq: bigint | null;
}

/** Mailboxes the mail service should keep connected: everything not disabled. */
export function listServiceMailboxes(db: Db) {
  return db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      credentialsEnc: mailboxes.credentialsEnc,
      status: mailboxes.status,
    })
    .from(mailboxes)
    .where(ne(mailboxes.status, "disabled"));
}

export async function findMailbox(db: Db, mailboxId: string) {
  const [row] = await db
    .select({ orgId: mailboxes.orgId, address: mailboxes.address, kind: mailboxes.kind })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return row ?? null;
}

export async function setMailboxStatus(
  db: Db,
  mailboxId: string,
  status: (typeof mailboxes.$inferSelect)["status"],
) {
  await db
    .update(mailboxes)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(mailboxes.id, mailboxId), ne(mailboxes.status, status)));
}

/**
 * Makes the stored folder list match the server's. Folders gone from the server are deleted,
 * which drops their locations; their messages stay until a sync proves them gone everywhere.
 */
export async function replaceFolders(
  db: Db,
  input: { orgId: string; mailboxId: string; folders: { path: string; role: FolderRole }[] },
) {
  const { orgId, mailboxId, folders } = input;
  await db.transaction(async (tx) => {
    for (const folder of folders) {
      await tx
        .insert(mailboxFolders)
        .values({ orgId, mailboxId, path: folder.path, role: folder.role })
        .onConflictDoUpdate({
          target: [mailboxFolders.mailboxId, mailboxFolders.path],
          set: { role: folder.role, updatedAt: new Date() },
          setWhere: ne(mailboxFolders.role, folder.role),
        });
    }
    const keep = folders.map((f) => f.path);
    await tx
      .delete(mailboxFolders)
      .where(
        keep.length > 0
          ? and(eq(mailboxFolders.mailboxId, mailboxId), notInArray(mailboxFolders.path, keep))
          : eq(mailboxFolders.mailboxId, mailboxId),
      );
  });
}

/** Null until the folder's first sync recorded its UIDVALIDITY. */
export async function getFolderPosition(
  db: Db,
  mailboxId: string,
  path: string,
): Promise<FolderPosition | null> {
  const [row] = await db
    .select({
      uidvalidity: mailboxFolders.uidvalidity,
      uidnext: mailboxFolders.uidnext,
      highestModseq: mailboxFolders.highestModseq,
    })
    .from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)));
  if (!row || row.uidvalidity === null) return null;
  return {
    uidvalidity: row.uidvalidity,
    uidnext: row.uidnext ?? 0,
    highestModseq: row.highestModseq,
  };
}

/** Saves where a folder's sync stopped. The folder row comes from `replaceFolders`. */
export async function saveFolderPosition(
  db: Db,
  mailboxId: string,
  path: string,
  position: FolderPosition,
) {
  const now = new Date();
  const rows = await db
    .update(mailboxFolders)
    .set({ ...position, syncedAt: now, updatedAt: now })
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)))
    .returning({ id: mailboxFolders.id });
  if (rows.length === 0) throw new Error(`folder ${path} of mailbox ${mailboxId} is not stored`);
}

/** UID → sorted flags for every stored copy in the folder. */
export async function folderLocations(db: Db, mailboxId: string, path: string) {
  const rows = await db
    .select({ uid: messageLocations.imapUid, flags: messageLocations.flags })
    .from(messageLocations)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)));
  return new Map(rows.map((row) => [row.uid, row.flags]));
}

export async function hasLocation(db: Db, mailboxId: string, path: string, uid: number) {
  const [row] = await db
    .select({ uid: messageLocations.imapUid })
    .from(messageLocations)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .where(
      and(
        eq(mailboxFolders.mailboxId, mailboxId),
        eq(mailboxFolders.path, path),
        eq(messageLocations.imapUid, uid),
      ),
    );
  return row !== undefined;
}

export async function findFolder(db: Db, mailboxId: string, path: string) {
  const [row] = await db
    .select({ id: mailboxFolders.id, role: mailboxFolders.role })
    .from(mailboxFolders)
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)));
  return row ?? null;
}

export async function findMessageByHeader(db: Db, mailboxId: string, messageIdHeader: string) {
  const [row] = await db
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageIdHeader)));
  return row ?? null;
}

/** Thread id per known Message-ID, for joining a reply by In-Reply-To/References. */
export async function threadsByMessageIds(db: Db, mailboxId: string, messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ header: messages.messageIdHeader, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.messageIdHeader, messageIds)));
  return new Map(rows.map((row) => [row.header, row.threadId]));
}

/**
 * Recent threads with this subject key and every address on their messages, for subject
 * threading. `since` bounds the scan; the threading rule applies its own window on top.
 */
export async function subjectThreadCandidates(
  db: Db,
  input: { mailboxId: string; subjectKey: string; since: Date; limit?: number },
) {
  const recent = await db
    .select({ id: threads.id, lastMessageAt: threads.lastMessageAt })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, input.mailboxId),
        eq(threads.subjectKey, input.subjectKey),
        gte(threads.lastMessageAt, input.since),
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(input.limit ?? 20);
  if (recent.length === 0) return [];
  const rows = await db
    .select({
      threadId: messages.threadId,
      from: messages.fromAddress,
      to: messages.to,
      cc: messages.cc,
    })
    .from(messages)
    .where(
      inArray(
        messages.threadId,
        recent.map((t) => t.id),
      ),
    );
  const byThread = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = byThread.get(row.threadId) ?? new Set<string>();
    set.add(row.from);
    for (const a of [...row.to, ...row.cc]) set.add(a.address);
    byThread.set(row.threadId, set);
  }
  return recent.map((t) => ({
    threadId: t.id,
    subjectKey: input.subjectKey,
    lastMessageAt: t.lastMessageAt,
    participants: [...(byThread.get(t.id) ?? [])],
  }));
}

/**
 * Records one IMAP copy of a stored message and makes it the message's current location.
 * Returns false when the copy was already recorded.
 */
export async function addLocation(
  db: Db,
  input: {
    orgId: string;
    mailboxId: string;
    folderId: string;
    uid: number;
    messageId: string;
    flags: string[];
    modseq: bigint | null;
  },
) {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messageLocations)
      .values({
        orgId: input.orgId,
        mailboxId: input.mailboxId,
        folderId: input.folderId,
        imapUid: input.uid,
        messageId: input.messageId,
        flags: input.flags,
        modseq: input.modseq,
      })
      .onConflictDoNothing()
      .returning({ uid: messageLocations.imapUid });
    if (inserted.length === 0) return false;
    await tx
      .update(messages)
      .set({ folderId: input.folderId, imapUid: input.uid, updatedAt: new Date() })
      .where(eq(messages.id, input.messageId));
    return true;
  });
}

export async function setLocationFlags(
  db: Db,
  input: {
    mailboxId: string;
    path: string;
    changes: { uid: number; flags: string[]; modseq: bigint | null }[];
  },
) {
  const folder = await findFolder(db, input.mailboxId, input.path);
  if (!folder) return;
  await db.transaction(async (tx) => {
    for (const change of input.changes) {
      await tx
        .update(messageLocations)
        .set({ flags: change.flags, modseq: change.modseq, updatedAt: new Date() })
        .where(
          and(eq(messageLocations.folderId, folder.id), eq(messageLocations.imapUid, change.uid)),
        );
    }
  });
}

/**
 * Forgets copies expunged or moved out of a folder (all of them when `uids` is omitted, for a
 * UIDVALIDITY reset). A message whose current location was one of them points at another copy,
 * or at nothing until a sync finds it again. Message rows stay: a move is seen as a removal here
 * before the copy shows up in the destination, and re-creating the row would re-triage it.
 */
export async function removeLocations(
  db: Db,
  input: { mailboxId: string; path: string; uids?: number[] },
) {
  const folder = await findFolder(db, input.mailboxId, input.path);
  if (!folder) return;
  if (input.uids?.length === 0) return;
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(messageLocations)
      .where(
        and(
          eq(messageLocations.folderId, folder.id),
          input.uids ? inArray(messageLocations.imapUid, input.uids) : undefined,
        ),
      )
      .returning({ messageId: messageLocations.messageId });
    if (removed.length === 0) return;
    const ids = [...new Set(removed.map((r) => r.messageId))];
    await tx.execute(sql`
      update ${messages} m set
        folder_id = l.folder_id,
        imap_uid = l.imap_uid,
        updated_at = now()
      from (
        select m2.id, nl.folder_id, nl.imap_uid
        from ${messages} m2
        left join lateral (
          select folder_id, imap_uid from ${messageLocations}
          where message_id = m2.id order by created_at desc limit 1
        ) nl on true
        where m2.id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}) and m2.folder_id = ${folder.id}
      ) l
      where m.id = l.id`);
  });
}

/** Marks the folder for a full re-sync: no sync position and no stored copies. */
export async function resetFolder(db: Db, mailboxId: string, path: string) {
  await removeLocations(db, { mailboxId, path });
  await db
    .update(mailboxFolders)
    .set({ uidvalidity: null, uidnext: null, highestModseq: null, updatedAt: new Date() })
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)));
}

/** SMTP accepted a claimed send. Persisted before anything else can fail. */
export async function markActionSmtpAccepted(db: Db, id: string) {
  await db
    .update(mailActions)
    .set({ smtpAcceptedAt: sql`coalesce(${mailActions.smtpAcceptedAt}, now())` })
    .where(eq(mailActions.id, id));
}

/**
 * Records a failed attempt with the caller's retry time, or marks the action `failed` when
 * `retryAt` is null. Use this when the caller owns the backoff policy; `failAction` applies its own.
 */
export async function rescheduleAction(db: Db, id: string, error: string, retryAt: Date | null) {
  const rows = await db
    .update(mailActions)
    .set({
      status: retryAt ? "pending" : "failed",
      runAfter: retryAt ?? sql`${mailActions.runAfter}`,
      lastError: error,
      lockedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mailActions.id, id), eq(mailActions.status, "running")))
    .returning({ id: mailActions.id });
  return rows.length > 0;
}
/** The member of `orgId` whose user has this email, for granting mailbox access. */
export async function findMemberByEmail(db: Db, orgId: string, email: string) {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(eq(members.organizationId, orgId), eq(sql`lower(${users.email})`, email.toLowerCase())),
    );
  return row?.id ?? null;
}

export async function findMailboxByAddress(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  return row?.id ?? null;
}

/**
 * Creates a mailbox, or replaces its credentials when it exists, and grants the owner access.
 * The caller picks `id` first because the credential ciphertext is bound to it.
 */
export async function saveMailbox(
  db: Db,
  input: {
    id: string;
    orgId: string;
    address: string;
    kind: (typeof mailboxes.$inferSelect)["kind"];
    provider: (typeof mailboxes.$inferSelect)["provider"];
    credentialsEnc: string;
    ownerMemberId: string;
  },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mailboxes)
      .values({
        id: input.id,
        orgId: input.orgId,
        address: input.address,
        kind: input.kind,
        provider: input.provider,
        credentialsEnc: input.credentialsEnc,
      })
      .onConflictDoUpdate({
        target: mailboxes.id,
        set: {
          kind: input.kind,
          provider: input.provider,
          credentialsEnc: input.credentialsEnc,
          status: "pending",
          updatedAt: new Date(),
        },
      })
      .returning({ id: mailboxes.id });
    await tx
      .insert(mailboxAccess)
      .values({
        orgId: input.orgId,
        mailboxId: row!.id,
        memberId: input.ownerMemberId,
        role: "owner",
      })
      .onConflictDoUpdate({
        target: [mailboxAccess.mailboxId, mailboxAccess.memberId],
        set: { role: "owner" },
      });
    return row!.id;
  });
}
