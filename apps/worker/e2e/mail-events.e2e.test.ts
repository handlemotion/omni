import { schema, type MailEventsBody } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  postMailEvents,
  seedMessage,
  startMailServiceEndpoint,
  startWorker,
  waitForEvents,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

const someEvents: MailEventsBody = {
  events: [{ kind: "message.updated", orgId: "o", mailboxId: "m", threadId: "t", messageId: "x" }],
};

test("forged, expired, unsigned-nonce and replayed mail events are rejected", async () => {
  const forged = await postMailEvents(worker, someEvents, {
    secret: "not-the-shared-secret-not-the-shared-secret",
  });
  expect(forged.status).toBe(401);

  const expired = await postMailEvents(worker, someEvents, {
    timestamp: Math.floor(Date.now() / 1000) - 120,
  });
  expect(expired.status).toBe(401);
  expect(await expired.json()).toEqual({ error: "expired" });

  const noNonce = await postMailEvents(worker, someEvents, { nonce: null });
  expect(noNonce.status).toBe(401);

  const nonce = "replay-nonce-0000000001";
  const timestamp = Math.floor(Date.now() / 1000);
  const valid = await postMailEvents(worker, someEvents, { nonce, timestamp });
  expect(valid.status).toBe(202);
  const replayed = await postMailEvents(worker, someEvents, { nonce, timestamp });
  expect(replayed.status).toBe(401);
  expect(await replayed.json()).toEqual({ error: "replayed" });
});

test("AI jobs converge on redelivery: ours-last files as waiting_on_them with no model call", async () => {
  const { db } = database;
  const org = await createOrg(db, "acme");
  const box = await createMailbox(db, org.id, "hello@acme.test");
  const first = await seedMessage(db, box, {
    subject: "Proposal",
    fromAddress: "luis@client.test",
    uid: 1,
    sentAt: new Date("2026-10-01T10:00:00Z"),
  });
  const ours = await seedMessage(db, box, {
    subject: "Re: Proposal",
    fromAddress: "Hello@Acme.test",
    folder: "Sent",
    uid: 1,
    threadId: first.threadId,
    sentAt: new Date("2026-10-01T11:00:00Z"),
  });
  const body: MailEventsBody = {
    events: [
      {
        kind: "message.created",
        orgId: org.id,
        mailboxId: box.id,
        threadId: first.threadId,
        messageId: ours.messageId,
      },
    ],
  };
  const forThread = (event: Record<string, unknown>) =>
    event.event === "ai.job" && event.threadId === first.threadId;
  const thread = async () =>
    (await db.select().from(schema.threads).where(eq(schema.threads.id, first.threadId)))[0];

  // Delivered twice, as the mail service may after a timeout.
  expect((await postMailEvents(worker, body)).status).toBe(202);
  expect((await postMailEvents(worker, body)).status).toBe(202);
  const outcomes = await waitForEvents(worker, forThread, 2);
  expect(outcomes.map((e) => e.outcome)).toEqual(["triaged", "triaged"]);
  expect(await thread()).toMatchObject({
    triage: "waiting_on_them",
    triageConfidence: 1,
    triageSource: "ai",
    summary: null,
  });
  // No model call was made, so nothing was spent.
  expect(await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.orgId, org.id))).toEqual(
    [],
  );

  // A person re-sorts it; a late redelivery must not undo that.
  await db
    .update(schema.threads)
    .set({ triage: "needs_reply", triageSource: "person" })
    .where(eq(schema.threads.id, first.threadId));
  expect((await postMailEvents(worker, body)).status).toBe(202);
  await waitForEvents(worker, forThread, 3);
  expect(await thread()).toMatchObject({ triage: "needs_reply", triageSource: "person" });
});
