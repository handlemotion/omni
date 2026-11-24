import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxFolders, messageLocations, messages } from "../schema/index.ts";
import { reconcileThreads } from "./thread-reconcile.ts";

type FolderRole = (typeof mailboxFolders.$inferSelect)["role"];

export interface FolderPosition {
  uidvalidity: number;
  uidnext: number;
  highestModseq: bigint | null;
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
export const getFolderPosition: (
  db: Db,
  mailboxId: string,
  path: string,
) => Promise<FolderPosition | null> = async (db, mailboxId, path) => {
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
};

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
    const [first] = input.flags.includes("\\Seen")
      ? []
      : await tx
          .select({ only: sql<boolean>`count(*) = 1` })
          .from(messageLocations)
          .where(eq(messageLocations.messageId, input.messageId));
    await reconcileThreads(tx, sql`${input.messageId}`, input.report ?? true, first?.only === true);
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
 * Reconciles every thread with a copy in this folder. A Google account's INBOX gets this on each
 * connect, so mail read in Gmail before Wok followed its read state is Done here too.
 */
export function reconcileFolder(db: Db, input: { mailboxId: string; path: string }) {
  return db.transaction((tx) =>
    reconcileThreads(
      tx,
      sql`select l.message_id from ${messageLocations} l
        join ${mailboxFolders} f on f.id = l.folder_id
        where f.mailbox_id = ${input.mailboxId} and f.path = ${input.path}`,
    ),
  );
}

/** Marks the folder for a full re-sync: no sync position and no stored copies. */
export async function resetFolder(db: Db, mailboxId: string, path: string) {
  await removeLocations(db, { mailboxId, path });
  await db
    .update(mailboxFolders)
    .set({ uidvalidity: null, uidnext: null, highestModseq: null, updatedAt: new Date() })
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, path)));
}
