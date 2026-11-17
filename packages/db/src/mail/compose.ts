// Member-scoped reads and writes for writing mail (ADR 0021): staged uploads, the attachments a
// send may carry, the agent's sending identity, and signatures. Like `member-mail.ts`, every
// query checks the member's grant on the row's mailbox in the row's org (`grantFor`).
import type { SendAttachment } from "@omni/contracts";
import { and, eq, exists, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { grantFor } from "./member-mail.ts";
import type { NewMailAction } from "./writers.ts";
import {
  attachments,
  drafts,
  mailActions,
  mailboxAccess,
  mailboxes,
  members,
  messages,
  organizations,
  signatures,
  uploads,
  users,
} from "../schema/index.ts";

/** A mailbox this member can see, or null. Never includes `credentials_enc`. */
export async function memberMailbox(db: Db, memberId: string, mailboxId: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      kind: mailboxes.kind,
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
    .where(eq(mailboxes.id, mailboxId));
  return row ?? null;
}

/** The member's name and their org's, for the From display name. */
export async function senderIdentity(db: Db, memberId: string) {
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      orgId: organizations.id,
      orgName: organizations.name,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.id, memberId));
  return row ?? null;
}

/** A fresh `uploads.id`, chosen before the bytes are stored so the key can name it. */
export function newUploadId() {
  return uuidv7();
}

/** Where an upload's bytes live: beside the mailbox's raw mail and attachments. */
export function uploadKey(upload: { orgId: string; mailboxId: string; id: string }) {
  return `${upload.orgId}/${upload.mailboxId}/uploads/${upload.id}`;
}

/** Records a file already written to `uploadKey(...)`. */
export async function createUpload(db: Db, upload: typeof uploads.$inferInsert & { id: string }) {
  const [row] = await db.insert(uploads).values(upload).returning();
  return row!;
}

/** An upload in a mailbox the member can see, or null. */
export async function memberUpload(db: Db, memberId: string, uploadId: string) {
  const [row] = await db
    .select({
      id: uploads.id,
      filename: uploads.filename,
      mimeType: uploads.mimeType,
      size: uploads.size,
      r2Key: uploads.r2Key,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.id, uploadId),
        exists(grantFor(db, memberId, uploads.mailboxId, uploads.orgId)),
      ),
    );
  return row ?? null;
}

/**
 * Deletes an upload no send has taken, if the member can see its mailbox. Returns its storage
 * key so the caller removes the object, or null (not found, or already sent).
 */
export async function deleteUnsentUpload(db: Db, memberId: string, uploadId: string) {
  const [row] = await db
    .delete(uploads)
    .where(
      and(
        eq(uploads.id, uploadId),
        isNull(uploads.usedAt),
        exists(grantFor(db, memberId, uploads.mailboxId, uploads.orgId)),
      ),
    )
    .returning({ r2Key: uploads.r2Key });
  return row?.r2Key ?? null;
}

/** The upload ids among a send's attachments. */
function uploadIdsOf(requested: SendAttachment[]) {
  return requested.flatMap((a) => (a.kind === "upload" ? [a.uploadId] : []));
}

/**
 * The files of `requested` that a send from `mailboxId` may not carry: uploads that are not this
 * mailbox's or expired unsent, and stored attachments of another mailbox's messages. Empty means
 * every one is fine. An upload a send already took stays valid, so a retried request (same
 * idempotency key) passes again. Inside a transaction the uploads it accepts stay locked until
 * commit, so a concurrent delete or expiry cleanup waits and then finds them used.
 */
async function invalidSendAttachments(db: Db, mailboxId: string, requested: SendAttachment[]) {
  const uploadIds = uploadIdsOf(requested);
  const attachmentIds = requested.flatMap((a) => (a.kind === "attachment" ? [a.attachmentId] : []));
  const okUploads = uploadIds.length
    ? await db
        .select({ id: uploads.id })
        .from(uploads)
        .where(
          and(
            inArray(uploads.id, uploadIds),
            eq(uploads.mailboxId, mailboxId),
            or(isNotNull(uploads.usedAt), gt(uploads.expiresAt, sql`now()`)),
          ),
        )
        .for("update")
    : [];
  const okAttachments = attachmentIds.length
    ? await db
        .select({ id: attachments.id })
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(and(inArray(attachments.id, attachmentIds), eq(messages.mailboxId, mailboxId)))
    : [];
  const ok = new Set([...okUploads, ...okAttachments].map((row) => row.id));
  return requested.filter(
    (a) => !ok.has(a.kind === "upload" ? a.uploadId : a.attachmentId),
  ) satisfies SendAttachment[];
}

/**
 * Queues a send and takes its uploads in one transaction: the uploads are checked and locked,
 * the outbox row is written, and the uploads are marked used before anything else can delete or
 * expire them. The row waits `delaySeconds` (the undo window) before the mail service may claim
 * it. With `draftId`, the draft is deleted in the same transaction, so two people sending one
 * shared draft at once queue one email: the second finds it gone (`draft_gone`).
 *
 * Returns the files the mailbox may not carry instead (nothing is written), or the action. A
 * repeated idempotency key returns the first row, as `enqueueAction` does, even once the draft
 * it consumed is gone.
 */
export async function enqueueSendWithAttachments(
  db: Db,
  input: NewMailAction & { kind: "send" },
  requested: SendAttachment[],
  options: { delaySeconds?: number; draftId?: string } = {},
) {
  const { delaySeconds = 0, draftId } = options;
  return db.transaction<
    | { invalid: SendAttachment[] }
    | { draftGone: true }
    | { action: typeof mailActions.$inferSelect }
  >(async (tx) => {
    const [earlier] = await tx
      .select()
      .from(mailActions)
      .where(eq(mailActions.idempotencyKey, input.idempotencyKey));
    if (earlier) return { action: earlier };
    const invalid = await invalidSendAttachments(tx, input.mailboxId, requested);
    if (invalid.length) return { invalid };
    if (draftId) {
      // Waits on a concurrent send of the same draft, then finds it deleted.
      const [taken] = await tx
        .delete(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.mailboxId, input.mailboxId)))
        .returning({ id: drafts.id });
      if (!taken) return { draftGone: true as const };
    }
    const [created] = await tx
      .insert(mailActions)
      .values({ ...input, runAfter: sql`now() + make_interval(secs => ${delaySeconds})` })
      .onConflictDoNothing({ target: mailActions.idempotencyKey })
      .returning();
    // A retry of the same request racing this one queued it first: answer with that row.
    if (!created) {
      const [existing] = await tx
        .select()
        .from(mailActions)
        .where(eq(mailActions.idempotencyKey, input.idempotencyKey));
      return { action: existing! };
    }
    const uploadIds = uploadIdsOf(requested);
    if (uploadIds.length) {
      await tx
        .update(uploads)
        .set({ usedAt: sql`now()` })
        .where(and(inArray(uploads.id, uploadIds), isNull(uploads.usedAt)));
    }
    return { action: created };
  });
}

/**
 * Up to `limit` uploads no send took whose time ran out, removed from Postgres. Returns their
 * storage keys for the caller to delete; an object left behind by a crash between the two is
 * unreachable, since nothing points at it.
 */
export async function takeExpiredUploads(db: Db, limit = 500) {
  const due = db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(isNull(uploads.usedAt), sql`${uploads.expiresAt} < now()`))
    .limit(limit);
  return db
    .delete(uploads)
    .where(and(inArray(uploads.id, due), isNull(uploads.usedAt)))
    .returning({ r2Key: uploads.r2Key });
}

/** `inbox`: the mailbox's signature; `mine`: this member's own on that mailbox. */
export type SignatureScope = "inbox" | "mine";

/**
 * The mailbox's signature and the member's own on it, null when unset. A composer uses the
 * member's own when there is one, else the inbox's. Null when the member cannot see the mailbox.
 */
export async function memberSignatures(db: Db, memberId: string, mailboxId: string) {
  const mailbox = await memberMailbox(db, memberId, mailboxId);
  if (!mailbox) return null;
  const rows = await db
    .select({
      memberId: signatures.memberId,
      bodyText: signatures.bodyText,
      bodyHtml: signatures.bodyHtml,
      updatedAt: signatures.updatedAt,
    })
    .from(signatures)
    .where(
      and(
        eq(signatures.mailboxId, mailboxId),
        or(isNull(signatures.memberId), eq(signatures.memberId, memberId)),
      ),
    );
  const pick = (mine: boolean) => {
    const row = rows.find((r) => (r.memberId === null) !== mine);
    return row
      ? { bodyText: row.bodyText, bodyHtml: row.bodyHtml, updatedAt: row.updatedAt }
      : null;
  };
  return { inbox: pick(false), mine: pick(true) };
}

/** Sets a signature (upsert on mailbox and member). False when the member cannot see the mailbox. */
export async function setSignature(
  db: Db,
  memberId: string,
  mailboxId: string,
  scope: SignatureScope,
  body: { bodyText: string; bodyHtml: string | null },
) {
  const mailbox = await memberMailbox(db, memberId, mailboxId);
  if (!mailbox) return false;
  await db
    .insert(signatures)
    .values({
      orgId: mailbox.orgId,
      mailboxId,
      memberId: scope === "mine" ? memberId : null,
      ...body,
    })
    .onConflictDoUpdate({
      target: [signatures.mailboxId, signatures.memberId],
      set: { ...body, updatedAt: new Date() },
    });
  return true;
}

/** Removes a signature. False when the member cannot see the mailbox. */
export async function deleteSignature(
  db: Db,
  memberId: string,
  mailboxId: string,
  scope: SignatureScope,
) {
  const mailbox = await memberMailbox(db, memberId, mailboxId);
  if (!mailbox) return false;
  await db
    .delete(signatures)
    .where(
      and(
        eq(signatures.mailboxId, mailboxId),
        scope === "mine" ? eq(signatures.memberId, memberId) : isNull(signatures.memberId),
      ),
    );
  return true;
}
