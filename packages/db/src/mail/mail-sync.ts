// Mail service writers for IMAP sync: folders, sync positions, message locations, mailboxes and
// outbox bookkeeping. Like `writers.ts`, only trusted background code calls these, and each one
// is idempotent so a repeated sync step converges.
import { and, desc, eq, gte, inArray, ne, notInArray, type SQL, sql } from "drizzle-orm";
import { MAX_PRUNED_THREADS_PER_EVENT } from "@omni/contracts";
import type { Db } from "../client.ts";
import { queueMailEvents, queueThreadsChanged } from "./pending-mail-events.ts";
import { rederiveParticipants } from "./thread-participants.ts";
import { syncableMailbox } from "./inbox-admin.ts";
import { ensureMailboxTeam, syncMailboxAccess } from "./mailbox-teams.ts";
import { assertCompany } from "../personal-space.ts";
import {
  mailActions,
  mailboxAccess,
  mailboxes,
  mailboxFolders,
  members,
  attachments,
  uploads,
  messageLocations,
  messages,
  threadState,
  threads,
  users,
} from "../schema/index.ts";

type FolderRole = (typeof mailboxFolders.$inferSelect)["role"];

export interface FolderPosition {
  uidvalidity: number;
  uidnext: number;
  highestModseq: bigint | null;
}

/**
 * Mailboxes the mail service should keep connected: everything not disabled, except a personal
 * inbox whose owner left the org (ADR 0026), which nobody can open until it is given away.
 */
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
    .where(and(ne(mailboxes.status, "disabled"), syncableMailbox));
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
    // Folders that are new or changed role. A role change moves threads in or out of the inbox
    // (Junk stored as `other`, later detected as `junk`), so their messages are reconciled below.
    const changed: string[] = [];
    for (const folder of folders) {
      const rows = await tx
        .insert(mailboxFolders)
        .values({ orgId, mailboxId, path: folder.path, role: folder.role })
        .onConflictDoUpdate({
          target: [mailboxFolders.mailboxId, mailboxFolders.path],
          set: { role: folder.role, updatedAt: new Date() },
          setWhere: ne(mailboxFolders.role, folder.role),
        })
        .returning({ id: mailboxFolders.id });
      changed.push(...rows.map((row) => row.id));
    }
    if (changed.length > 0) {
      await reconcileThreads(
        tx,
        sql`select message_id from ${messageLocations} where folder_id in (${sql.join(
          changed.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
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
 * Thread of the newest stored message that names any of `messageIds` in its In-Reply-To or
 * References: a reply that arrived before this message, or a sibling with the same parent. Pass
 * the new message's own Message-ID and its reply ids.
 */
export async function threadReferencing(db: Db, mailboxId: string, messageIds: string[]) {
  if (messageIds.length === 0) return null;
  const ids = sql`array[${sql.join(
    messageIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`(${messages.inReplyTo} = any(${ids}) or ${messages.references} && ${ids})`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return row?.threadId ?? null;
}

/**
 * Threads holding a stored reply to `messageId` (it names it in In-Reply-To or References). More
 * than one, or one besides the thread the message joins, means the conversation was split while
 * this message was missing, and those threads merge (`mergeThreads`).
 */
export async function threadsReplyingTo(db: Db, mailboxId: string, messageId: string) {
  const rows = await db
    .selectDistinct({ threadId: messages.threadId })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`(${messages.inReplyTo} = ${messageId} or ${messages.references} @> array[${messageId}]::text[])`,
      ),
    );
  return rows.map((row) => row.threadId);
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
    /**
     * Queue `threads.changed` when the thread's state changes (a copy moved in another mail
     * app). False for a message just indexed: `message.created` already refreshes its thread.
     */
    report?: boolean;
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
    await reconcileThreads(tx, sql`${input.messageId}`, input.report ?? true);
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
  if (input.changes.length === 0) return 0;
  // One statement for the whole batch: a CONDSTORE resync can report thousands of changes.
  const changes = JSON.stringify(
    input.changes.map((c) => ({
      uid: c.uid,
      flags: c.flags,
      modseq: c.modseq?.toString() ?? null,
    })),
  );
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      update ${messageLocations} l set
        flags = c.flags,
        modseq = c.modseq,
        updated_at = now()
      from ${mailboxFolders} f,
        jsonb_to_recordset(${changes}::text::jsonb) as c(uid bigint, flags text[], modseq bigint)
      where f.mailbox_id = ${input.mailboxId} and f.path = ${input.path}
        and l.folder_id = f.id and l.imap_uid = c.uid`);
    return reconcileThreads(
      tx,
      sql`select l.message_id from ${messageLocations} l
        join ${mailboxFolders} f on f.id = l.folder_id,
        jsonb_to_recordset(${changes}::text::jsonb) as c(uid bigint)
        where f.mailbox_id = ${input.mailboxId} and f.path = ${input.path} and l.imap_uid = c.uid`,
    );
  });
}

/**
 * Forgets copies expunged or moved out of a folder (all of them when `uids` is omitted, for a
 * UIDVALIDITY reset). A message whose current location was one of them points at another copy,
 * or at nothing until a sync finds it again. Message rows stay: a move is seen as a removal here
 * before the copy shows up in the destination, and re-creating the row would re-triage it. A row
 * that a full sync still finds nowhere is deleted by `pruneMessages`.
 */
export async function removeLocations(
  db: Db,
  input: { mailboxId: string; path: string; uids?: number[] },
) {
  const folder = await findFolder(db, input.mailboxId, input.path);
  if (!folder) return 0;
  if (input.uids?.length === 0) return 0;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(messageLocations)
      .where(
        and(
          eq(messageLocations.folderId, folder.id),
          input.uids ? inArray(messageLocations.imapUid, input.uids) : undefined,
        ),
      )
      .returning({ messageId: messageLocations.messageId });
    if (removed.length === 0) return 0;
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
    return reconcileThreads(
      tx,
      sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      ),
    );
  });
}

/**
 * Brings the threads of these messages (`messageIds`: a list of ids or a query selecting them) in line with where their IMAP copies are and how they
 * are flagged, so that state set in Omni, in Apple Mail, or by a full re-sync all end up the same
 * (spec, "Sync rules"):
 *
 * - Archived: a copy in INBOX means not archived; otherwise a copy in the archive, trash or junk
 *   folder means archived (out of the inbox: deleted or junked mail is not waiting for an answer).
 *   A thread with none of these (Sent only, another folder, or mid-move) keeps its state.
 * - Read, on personal mailboxes only: read when every copy has `\Seen`, for every member with
 *   access. Shared mailboxes keep read per person in Postgres and never look at `\Seen`.
 */
async function reconcileThreads(
  db: Pick<Db, "execute" | "insert" | "select">,
  messageIds: SQL,
  report = true,
): Promise<number> {
  const summary = sql`
    select m.thread_id,
      bool_or(f.role = 'inbox') as in_inbox,
      bool_or(f.role in ('archive', 'trash', 'junk')) as filed,
      bool_and(${"\\Seen"}::text = any(l.flags)) as seen
    from ${messages} m
    join ${messageLocations} l on l.message_id = m.id
    join ${mailboxFolders} f on f.id = l.folder_id
    where m.thread_id in (select thread_id from ${messages} where id in (${messageIds}))
    group by m.thread_id`;
  const archived = await db.execute(sql`
    update ${threads} t set archived = not s.in_inbox, updated_at = now()
    from (${summary}) s
    where t.id = s.thread_id and (s.in_inbox or s.filed) and t.archived = s.in_inbox
    returning t.id`);
  const read = await db.execute(sql`
    insert into ${threadState} (org_id, thread_id, member_id, read)
    select t.org_id, t.id, a.member_id, s.seen
    from (${summary}) s
    join ${threads} t on t.id = s.thread_id
    join ${mailboxes} mb on mb.id = t.mailbox_id and mb.kind = 'personal'
    join ${mailboxAccess} a on a.mailbox_id = t.mailbox_id
    on conflict (thread_id, member_id) do update set read = excluded.read, updated_at = now()
    where ${threadState}.read is distinct from excluded.read
    returning thread_id as id, read, xmax = 0 as inserted`);
  // postgres-js returns the rows themselves. A new row that says unread shows what no row did.
  type ReadRow = { id: string; read: boolean; inserted: boolean };
  const changed = [
    ...(archived as unknown as { id: string }[]),
    ...(read as unknown as ReadRow[]).filter((row) => row.read || !row.inserted),
  ];
  const threadIds = [...new Set(changed.map((row) => row.id))];
  if (report) await queueThreadsChanged(db, threadIds);
  return threadIds.length;
}

/**
 * Messages of the mailbox with no IMAP copy left in any stored folder. A send still in the outbox
 * is not one: it was indexed when SMTP accepted it and its Sent copy is still to be filed.
 */
export async function orphanedMessages(db: Db, mailboxId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        sql`not exists (select 1 from ${messageLocations} l where l.message_id = ${messages.id})`,
        sql`not exists (select 1 from ${mailActions} a
          where a.mailbox_id = ${messages.mailboxId} and a.kind = 'send'
            and a.status in ('pending', 'running')
            and (a.payload->>'messageId' = ${messages.messageIdHeader}
              -- No Message-ID in the payload: the outbox derives one from the idempotency key
              -- (deterministicMessageId in apps/mail/src/outbox.ts).
              or (a.payload->>'messageId' is null and ${messages.messageIdHeader} like
                '<' || left(encode(sha256(convert_to('omni-send:' || a.idempotency_key, 'UTF8')), 'hex'), 32) || '@%')))`,
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Deletes messages that were deleted on the server: of `messageIds`, those that still have no IMAP
 * copy. A thread left with no messages goes too (its per-member state and AI output cascade); a
 * thread that keeps some takes its last message time from what is left. `threadIds` are every
 * thread that lost a message, deleted or not. The caller decides when a
 * missing copy means deleted rather than mid-move (see `MailboxConnection.syncAll`).
 */
export async function pruneMessages(
  db: Db,
  input: { mailboxId: string; messageIds: string[] },
): Promise<{ messages: number; threads: number; threadIds: string[] }> {
  if (input.messageIds.length === 0) return { messages: 0, threads: 0, threadIds: [] };
  // One jsonb parameter, not one per id: a deleted folder can orphan more ids than Postgres binds.
  const anyOf = (ids: string[]) =>
    sql`any(array(select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)))`;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          sql`${messages.id} = ${anyOf(input.messageIds)}`,
          sql`not exists (select 1 from ${messageLocations} l where l.message_id = ${messages.id})`,
        ),
      )
      .returning({ orgId: messages.orgId, threadId: messages.threadId });
    const threadIds = [...new Set(removed.map((row) => row.threadId))];
    const orgId = removed[0]?.orgId;
    if (threadIds.length === 0 || !orgId) return { messages: 0, threads: 0, threadIds };
    const emptied = await tx
      .delete(threads)
      .where(
        and(
          sql`${threads.id} = ${anyOf(threadIds)}`,
          sql`not exists (select 1 from ${messages} m where m.thread_id = ${threads.id})`,
        ),
      )
      .returning({ id: threads.id });
    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`(select max(m.sent_at) from ${messages} m where m.thread_id = ${threads.id})`,
        updatedAt: new Date(),
      })
      .where(sql`${threads.id} = ${anyOf(threadIds)}`);
    // A thread that keeps messages drops the addresses only the deleted ones had.
    await rederiveParticipants(tx, threadIds);
    // Queued with the delete, so open apps drop these threads even if the service dies next.
    await queueMailEvents(
      tx,
      chunks(threadIds, MAX_PRUNED_THREADS_PER_EVENT).map((chunk) => ({
        type: "messages.pruned" as const,
        orgId,
        mailboxId: input.mailboxId,
        threadIds: chunk,
      })),
    );
    return { messages: removed.length, threads: emptied.length, threadIds };
  });
}

/**
 * Messages whose `message.created` the Worker has not accepted yet (`notify_pending`), oldest
 * first: the mail service died or the Worker was down before delivery. Re-sending is safe; the
 * Worker dedupes by message id.
 */
export async function pendingNotifications(db: Db, limit: number) {
  const rows = await db
    .select({
      orgId: messages.orgId,
      mailboxId: messages.mailboxId,
      threadId: messages.threadId,
      messageId: messages.id,
      role: mailboxFolders.role,
    })
    .from(messages)
    .leftJoin(mailboxFolders, eq(mailboxFolders.id, messages.folderId))
    .where(eq(messages.notifyPending, true))
    .orderBy(messages.id)
    .limit(limit);
  // No folder yet: a reply indexed when SMTP accepted it (its Sent copy is not filed yet).
  return rows.map(({ role, ...row }) => ({ ...row, folderRole: role ?? ("sent" as const) }));
}

/** The Worker accepted `message.created` for these messages. */
export async function markNotified(db: Db, messageIds: string[]) {
  if (messageIds.length === 0) return;
  await db
    .update(messages)
    .set({ notifyPending: false })
    .where(and(inArray(messages.id, messageIds), eq(messages.notifyPending, true)));
}

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

/** Thread of a stored message in this mailbox, for filing a forward with what it forwards. */
export async function messageThread(db: Db, mailboxId: string, messageId: string) {
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.id, messageId)));
  return row?.threadId ?? null;
}

/** When the next pending outbox action is due (an undo-send window ends), or null. */
export async function nextActionDue(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`min(${mailActions.runAfter})` })
    .from(mailActions)
    .where(eq(mailActions.status, "pending"));
  return row?.at ? new Date(row.at) : null;
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
    // The member who asked learns it failed; queued with the status, so it is never lost.
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
 * Creates a mailbox, or replaces its credentials when it exists, and grants the owner access. A
 * shared mailbox also gets its Better Auth team, with the owner on it.
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
    /** Null only for a personal inbox waiting for an invitee (ADR 0026): no grant yet. */
    ownerMemberId: string | null;
  },
) {
  if (input.ownerMemberId === null && input.kind !== "personal") {
    throw new Error("a shared mailbox needs someone on it");
  }
  return db.transaction(async (tx) => {
    // Shared mailboxes are a company's (ADR 0024).
    if (input.kind === "shared") await assertCompany(tx, input.orgId, "a shared mailbox");
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
    if (input.ownerMemberId !== null) {
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
    }
    // A shared mailbox's team is its access list (ADR 0008). A new one is seeded with the owner
    // grant above; for one that already has a team, the team decides and the sync wins.
    if (input.kind === "shared") {
      await ensureMailboxTeam(tx, row!.id);
      await syncMailboxAccess(tx, row!.id);
    }
    return row!.id;
  });
}

/** Members holding an owner grant on the mailbox. */
export async function mailboxOwnerIds(db: Db, mailboxId: string): Promise<string[]> {
  const rows = await db
    .select({ memberId: mailboxAccess.memberId })
    .from(mailboxAccess)
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.role, "owner")));
  return rows.map((row) => row.memberId);
}

/** Gmail mailboxes at `address` in any workspace: one Google account syncs into one place. */
export function findGmailMailboxes(db: Db, address: string) {
  return db
    .select({ id: mailboxes.id, orgId: mailboxes.orgId })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.address, address)));
}

/** A mailbox with what disconnecting it needs, scoped to its org; null when it is not there. */
export async function findOrgMailboxById(db: Db, orgId: string, mailboxId: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      credentialsEnc: mailboxes.credentialsEnc,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.id, mailboxId)));
  return row ?? null;
}

/**
 * Deletes a mailbox and, through cascades, everything indexed from it (threads, messages,
 * folders, grants, notes). Postgres is only an index of the provider's mail, so nothing is lost
 * that the provider does not still hold. Idempotent.
 */
export async function deleteMailbox(db: Db, mailboxId: string) {
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
}

/**
 * Files a stored message under another thread (the provider grouped it elsewhere). The thread it
 * leaves is deleted when that left it empty, else its `last_message_at` is recomputed; the one it
 * joins moves forward to the message when it is newer.
 */
export async function moveMessageToThread(
  db: Db,
  input: { mailboxId: string; messageId: string; threadId: string },
) {
  await db.transaction(async (tx) => {
    const [moved] = await tx
      .select({ from: messages.threadId, sentAt: messages.sentAt })
      .from(messages)
      .where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.id, input.messageId)));
    if (!moved || moved.from === input.threadId) return;
    await tx
      .update(messages)
      .set({ threadId: input.threadId, updatedAt: new Date() })
      .where(eq(messages.id, input.messageId));
    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${moved.sentAt.toISOString()}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, input.threadId));
    const [emptied] = await tx
      .delete(threads)
      .where(
        and(
          eq(threads.id, moved.from),
          sql`not exists (select 1 from ${messages} m where m.thread_id = ${threads.id})`,
        ),
      )
      .returning({ id: threads.id });
    if (!emptied) {
      await tx
        .update(threads)
        .set({
          lastMessageAt: sql`(select max(m.sent_at) from ${messages} m where m.thread_id = ${threads.id})`,
          updatedAt: new Date(),
        })
        .where(eq(threads.id, moved.from));
    }
    // Its addresses follow it; the thread it left keeps only what its other messages have.
    await rederiveParticipants(tx, [moved.from, input.threadId]);
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
