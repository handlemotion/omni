// Mail's minute job (`src/mail/jobs.ts`, registered on the mail module in `src/modules.ts`) run
// through the real Worker's cron under workerd, against Postgres: the `thread_participants`
// backfill (ADR 0036 decision 4) beside the helpdesk's clock.
import { randomUUID } from "node:crypto";
import { createThread, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  startMailServiceEndpoint,
  startWorker,
  workerEvents,
} from "./support.ts";

const MINUTE_CRON = "* * * * *";

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

/** A UUIDv7 made `agoMs` ago, as the mail service would have given a message stored then. */
function uuidv7Ago(agoMs: number) {
  const hex = (Date.now() - agoMs).toString(16).padStart(12, "0");
  const rest = randomUUID().replaceAll("-", "");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${rest.slice(0, 3)}-8${rest.slice(3, 6)}-${rest.slice(6, 18)}`;
}

// Catches: mail stored before `thread_participants` existed (or by an older mail service) never
// reaching a CRM timeline, because the minute cron does not run mail's job, or its Effect
// program fails under workerd; and a run that indexes the same mail again.
test("the minute cron indexes the participants of mail stored without them, then finds nothing to do", async () => {
  const { db } = database;
  const org = await createOrg(db, "backfill");
  const box = await createMailbox(db, org.id, "inbox@backfill.test");
  // As an older mail service stored it an hour ago: the messages, no participant rows.
  for (let i = 1; i <= 3; i++) {
    const sentAt = new Date(Date.now() - 3_600_000 + i);
    const threadId = await createThread(db, {
      orgId: org.id,
      mailboxId: box.id,
      subjectKey: `hello ${i}`,
      lastMessageAt: sentAt,
    });
    await db.insert(schema.messages).values({
      id: uuidv7Ago(3_600_000 - i),
      orgId: org.id,
      mailboxId: box.id,
      threadId,
      messageIdHeader: `<${randomUUID()}@backfill.test>`,
      subject: `Hello ${i}`,
      fromAddress: `Client${i}@Acme.test`,
      to: [{ name: null, address: box.address }],
      sentAt,
    });
  }

  const outcome = async () =>
    (await worker.server.getWorker().scheduled({ cron: MINUTE_CRON })).outcome;
  expect(await outcome()).toBe("ok");

  const rows = await db
    .select({ address: schema.threadParticipants.address })
    .from(schema.threadParticipants)
    .where(eq(schema.threadParticipants.mailboxId, box.id));
  expect(rows.map((row) => row.address).toSorted()).toEqual(
    [
      "client1@acme.test",
      "client2@acme.test",
      "client3@acme.test",
      box.address,
      box.address,
      box.address,
    ].toSorted(),
  );
  const indexed = () => workerEvents(worker).filter((e) => e.event === "mail.participants_indexed");
  expect(indexed()).toMatchObject([{ component: "mail", messages: 3, participants: 6 }]);

  expect(await outcome()).toBe("ok");
  expect(indexed()).toHaveLength(1);
});
