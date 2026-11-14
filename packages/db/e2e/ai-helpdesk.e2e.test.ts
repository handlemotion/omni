// Helpdesk triage against two races (ADR 0033): the AI job can run before its message's own
// ingest, and a teammate can re-sort the message while the model is still answering. Real
// Postgres; the conversation and its message are written the way the mail service writes them.
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { applyAiHelpdeskTriage, awaitingIngest, INGEST_WAIT_MS } from "../src/ai-helpdesk.ts";
import { applyInboundMessage } from "../src/conversations.ts";
import { threads } from "../src/schema/index.ts";
import { createThread, upsertMessage } from "../src/writers.ts";
import { createMailbox, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

/** A shared inbox's conversation with one customer message, as sync leaves it before ingest. */
async function customerWrites(slug: string) {
  const org = await createOrg(db, slug);
  const mailbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const threadId = await createThread(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    subjectKey: "weekly deals",
    lastMessageAt: new Date(),
  });
  const message = await upsertMessage(db, {
    orgId: org.id,
    mailboxId: mailbox.id,
    threadId,
    messageIdHeader: `<${threadId}@deals.test>`,
    subject: "Weekly deals",
    fromAddress: "news@deals.test",
    sentAt: new Date(),
    cleanText: "Our best deals this week.",
  });
  return { threadId, messageId: message.id };
}

const noise = { priority: "low" as const, tagIds: [], assigneeId: null, resolveNoise: true };

test("triage waits for the message's own ingest, and only for a while", async () => {
  const { messageId } = await customerWrites("ingest");
  expect(await awaitingIngest(db, messageId)).toBe(true);
  // Mail from before the helpdesk never gets an ingest: past the wait, triage takes it as it is.
  const later = new Date(Date.now() + INGEST_WAIT_MS + 1_000);
  expect(await awaitingIngest(db, messageId, later)).toBe(false);
  await applyInboundMessage(db, { messageId });
  expect(await awaitingIngest(db, messageId)).toBe(false);
});

test("a teammate's re-sort while the model ran stops the AI from resolving it", async () => {
  const { threadId, messageId } = await customerWrites("resort");
  await applyInboundMessage(db, { messageId });
  // The teammate filed this message as Needs reply while triage was out.
  await db
    .update(threads)
    .set({ triage: "needs_reply", triageSource: "person", triageMessageId: messageId })
    .where(eq(threads.id, threadId));
  expect(await applyAiHelpdeskTriage(db, { threadId, messageId, changes: noise })).toEqual({
    applied: false,
  });
  const [row] = await db
    .select({ status: threads.status, archived: threads.archived })
    .from(threads)
    .where(eq(threads.id, threadId));
  expect(row).toEqual({ status: "open", archived: false });

  // Without the re-sort, the same triage resolves it: the guard is what held it open.
  await db.update(threads).set({ triageSource: "ai" }).where(eq(threads.id, threadId));
  expect(await applyAiHelpdeskTriage(db, { threadId, messageId, changes: noise })).toMatchObject({
    applied: true,
    changed: true,
  });
});
