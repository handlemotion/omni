// System writers for the mail service. They are not member-scoped: only trusted background code
// calls them, never a route handling a member's request. Each one is idempotent.
import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import type { ActionPayload, MailActionKind } from "@omni/contracts";
import { attachments, mailActions, mailboxFolders, messages, threads } from "./schema/index.ts";

type NewMessage = Omit<
  typeof messages.$inferInsert,
  "id" | "searchVector" | "createdAt" | "updatedAt"
>;
type NewAttachment = Omit<
  typeof attachments.$inferInsert,
  "id" | "orgId" | "messageId" | "createdAt"
>;

export async function createThread(
  db: Db,
  input: Pick<typeof threads.$inferInsert, "orgId" | "mailboxId" | "subjectKey" | "lastMessageAt">,
) {
  const [row] = await db.insert(threads).values(input).returning({ id: threads.id });
  return row!.id;
}

/** Thread holding any of these Message-IDs in the mailbox, for In-Reply-To/References joins. */
export async function findThreadByMessageIds(db: Db, mailboxId: string, messageIds: string[]) {
  if (messageIds.length === 0) return null;
  const [row] = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.messageIdHeader, messageIds)))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return row?.threadId ?? null;
}

/**
 * Inserts a message once per (mailbox_id, message_id_header). A repeat refreshes only where it
 * lives now (folder, UID, R2 key), so re-syncs and moves converge on one row. Attachments are
 * written with the first insert, and the thread's `last_message_at` only moves forward.
 */
export async function upsertMessage(db: Db, input: NewMessage & { attachments?: NewAttachment[] }) {
  const { attachments: files = [], ...message } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values(message)
      .onConflictDoUpdate({
        target: [messages.mailboxId, messages.messageIdHeader],
        set: {
          folderId: sql`coalesce(excluded.folder_id, ${messages.folderId})`,
          imapUid: sql`coalesce(excluded.imap_uid, ${messages.imapUid})`,
          r2Key: sql`coalesce(excluded.r2_key, ${messages.r2Key})`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: messages.id,
        threadId: messages.threadId,
        inserted: sql<boolean>`xmax = 0`,
      });
    const { id, threadId, inserted } = row!;

    if (inserted && files.length > 0) {
      await tx
        .insert(attachments)
        .values(files.map((file) => ({ ...file, orgId: message.orgId, messageId: id })));
    }
    await tx
      .update(threads)
      .set({
        lastMessageAt: sql`greatest(${threads.lastMessageAt}, ${message.sentAt.toISOString()}::timestamptz)`,
      })
      .where(eq(threads.id, threadId));
    return { id, threadId, inserted };
  });
}

/** Saves a folder's sync position, creating the folder on first sight. */
export async function upsertFolder(
  db: Db,
  input: Pick<
    typeof mailboxFolders.$inferInsert,
    "orgId" | "mailboxId" | "path" | "role" | "uidvalidity" | "uidnext" | "highestModseq"
  >,
) {
  const now = new Date();
  const [row] = await db
    .insert(mailboxFolders)
    .values({ ...input, syncedAt: now })
    .onConflictDoUpdate({
      target: [mailboxFolders.mailboxId, mailboxFolders.path],
      set: {
        role: input.role,
        uidvalidity: input.uidvalidity,
        uidnext: input.uidnext,
        highestModseq: input.highestModseq,
        syncedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row!;
}

/** An action kind with the payload `@omni/contracts` defines for it; one never pairs with another's. */
export type MailActionRequest = {
  [K in MailActionKind]: { kind: K; payload: ActionPayload<K> };
}[MailActionKind];

/** One outbox row to add. */
export type NewMailAction = Pick<
  typeof mailActions.$inferInsert,
  "orgId" | "mailboxId" | "memberId" | "idempotencyKey" | "requestId"
> &
  MailActionRequest;

/** Adds an action to the outbox. A repeated idempotency key returns the existing row. */
export async function enqueueAction(db: Db, input: NewMailAction) {
  const [created] = await db
    .insert(mailActions)
    .values(input)
    .onConflictDoNothing({ target: mailActions.idempotencyKey })
    .returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(mailActions)
    .where(eq(mailActions.idempotencyKey, input.idempotencyKey));
  return existing!;
}

/**
 * Claims up to `limit` due actions for one worker. `FOR UPDATE SKIP LOCKED` keeps concurrent
 * claimers off each other's rows. A `running` row whose lease is older than `leaseMs` belongs to
 * a worker that died and is claimed again.
 */
export async function claimActions(db: Db, options: { limit?: number; leaseMs?: number } = {}) {
  const { limit = 10, leaseMs = 5 * 60_000 } = options;
  const due = db
    .select({ id: mailActions.id })
    .from(mailActions)
    .where(
      or(
        and(eq(mailActions.status, "pending"), lte(mailActions.runAfter, sql`now()`)),
        and(
          eq(mailActions.status, "running"),
          lt(mailActions.lockedAt, sql`now() - make_interval(secs => ${leaseMs / 1000})`),
        ),
      ),
    )
    .orderBy(mailActions.runAfter)
    .limit(limit)
    .for("update", { skipLocked: true });
  return db
    .update(mailActions)
    .set({
      status: "running",
      attempts: sql`${mailActions.attempts} + 1`,
      lockedAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(inArray(mailActions.id, due))
    .returning();
}

/** Marks a claimed action done. Returns false if it was not running (e.g. lease lost). */
export async function completeAction(db: Db, id: string) {
  const rows = await db
    .update(mailActions)
    .set({ status: "done", completedAt: sql`now()`, lockedAt: null, lastError: null })
    .where(and(eq(mailActions.id, id), eq(mailActions.status, "running")))
    .returning({ id: mailActions.id });
  return rows.length > 0;
}
