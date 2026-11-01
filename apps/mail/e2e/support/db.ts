// Postgres side of the mail e2e suites: one throwaway, migrated database per file (from
// `@omni/db/testing`), plus readers that show what the service stored.
import { enqueueAction, schema } from "@omni/db";
import { createMember, createOrg, createTestDatabase } from "@omni/db/testing";
import { and, asc, eq } from "drizzle-orm";
import type { MailboxConfig } from "../../src/mailbox-connection.ts";
import type { MailAction } from "../../src/ports.ts";
import { mailbox } from "./greenmail.ts";

export { createTestDatabase };
export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>["db"];

const { mailActions, mailboxAccess, mailboxFolders, mailboxes, messageLocations, messages } =
  schema;

/** A GreenMail mailbox with its `mailboxes` row and an owner. */
export async function seedMailbox(
  db: TestDb,
  options: { kind?: MailboxConfig["kind"]; credentialsEnc?: string } = {},
) {
  const box = mailbox(options.kind);
  const org = await createOrg(db, `org-${box.id.slice(0, 8)}`);
  const owner = await createMember(db, org.id, "owner");
  const config: MailboxConfig = { ...box, orgId: org.id };
  await db.insert(mailboxes).values({
    id: config.id,
    orgId: org.id,
    address: config.address,
    kind: config.kind,
    credentialsEnc: options.credentialsEnc ?? "unused-by-direct-connections",
  });
  await db
    .insert(mailboxAccess)
    .values({ orgId: org.id, mailboxId: config.id, memberId: owner.id, role: "owner" });
  return { box: config, orgId: org.id, ownerId: owner.id };
}

export async function setCredentials(db: TestDb, mailboxId: string, credentialsEnc: string) {
  await db.update(mailboxes).set({ credentialsEnc }).where(eq(mailboxes.id, mailboxId));
}

export async function mailboxStatus(db: TestDb, mailboxId: string) {
  const [row] = await db
    .select({ status: mailboxes.status })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return row?.status;
}

/** Every stored copy in a folder with its message, oldest UID first. */
export async function stored(db: TestDb, mailboxId: string, folder: string) {
  return db
    .select({
      uid: messageLocations.imapUid,
      flags: messageLocations.flags,
      messageId: messages.id,
      messageIdHeader: messages.messageIdHeader,
      threadId: messages.threadId,
      subject: messages.subject,
      cleanText: messages.cleanText,
      r2Key: messages.r2Key,
      htmlR2Key: messages.htmlR2Key,
    })
    .from(messageLocations)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .innerJoin(messages, eq(messages.id, messageLocations.messageId))
    .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.path, folder)))
    .orderBy(asc(messageLocations.imapUid));
}

/** Message rows of a mailbox in insertion order (ids are UUIDv7). */
export function messageRows(db: TestDb, mailboxId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.mailboxId, mailboxId))
    .orderBy(asc(messages.id));
}

export async function enqueue(
  db: TestDb,
  seeded: { box: MailboxConfig; orgId: string; ownerId: string },
  input: { kind: MailAction["kind"]; idempotencyKey: string; payload: object },
) {
  return enqueueAction(db, {
    orgId: seeded.orgId,
    mailboxId: seeded.box.id,
    memberId: seeded.ownerId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload as Record<string, unknown>,
  });
}

export async function actionRow(db: TestDb, id: string) {
  const [row] = await db.select().from(mailActions).where(eq(mailActions.id, id));
  if (!row) throw new Error(`no action ${id}`);
  return row;
}

/** The row as a fresh claim would hand it to the executor, without claiming it. */
export async function asClaimed(db: TestDb, id: string): Promise<MailAction> {
  const row = await actionRow(db, id);
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    kind: row.kind,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    smtpAcceptedAt: row.smtpAcceptedAt,
  } as unknown as MailAction;
}
