import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@omni/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  postMailEvents,
  seedMessage,
  startMailServiceEndpoint,
  startWorker,
} from "./support.ts";

const MINUTE_CRON = "* * * * *";
const invite = readFileSync(
  join(import.meta.dirname, "../../../fixtures/ics/google-invite.ics"),
  "utf8",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
}, 60_000);

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

interface MailBucket {
  put(key: string, body: string): Promise<unknown>;
}

let uid = 0;

async function invitation(folder: "INBOX" | "Junk" = "INBOX", uidValue = ++uid) {
  const { db } = database;
  const org = await createOrg(db, `calendar-${crypto.randomUUID().slice(0, 8)}`);
  const member = await createMember(db, org.id, `rodrigo-${crypto.randomUUID()}@studio.example`);
  const inbox = await createMailbox(db, org.id, "rodrigo@studio.example", "personal");
  await grant(db, org.id, inbox.id, member.id);
  const seeded = await seedMessage(db, inbox, {
    subject: "Invitation: Acme × Studio: kickoff",
    fromAddress: "ana@acme.example",
    uid: uidValue,
    folder,
  });
  if (folder === "Junk") {
    await db
      .update(schema.mailboxFolders)
      .set({ role: "junk" })
      .where(eq(schema.mailboxFolders.id, seeded.folder.id));
  }
  const r2Key = `${org.id}/${inbox.id}/att/${crypto.randomUUID()}`;
  const env = await worker.server.getWorker<{ MAIL_BUCKET: MailBucket }>().getEnv();
  await env.MAIL_BUCKET.put(r2Key, invite);
  const [attachment] = await db
    .insert(schema.attachments)
    .values({
      orgId: org.id,
      messageId: seeded.messageId,
      filename: "invite.ics",
      mimeType: "text/calendar",
      size: invite.length,
      r2Key,
    })
    .returning();
  return { org, inbox, attachment: attachment!, ...seeded };
}

const eventsOf = (orgId: string) =>
  database.db
    .select({ title: schema.calendarEvents.title, startsAt: schema.calendarEvents.startsAt })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.orgId, orgId));

async function until<T>(read: () => Promise<T[]>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await read();
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("an invitation is on the calendar within seconds of its arrival event", async () => {
  const { org, inbox, threadId, messageId } = await invitation();
  const started = Date.now();
  const response = await postMailEvents(worker, {
    events: [
      {
        type: "message.created",
        orgId: org.id,
        mailboxId: inbox.id,
        threadId,
        messageId,
        folderRole: "inbox",
      },
    ],
  });
  expect(response.status).toBe(202);
  const events = await until(() => eventsOf(org.id));
  expect(events).toEqual([
    { title: "Acme × Studio: kickoff", startsAt: new Date("2026-11-24T15:30:00Z") },
  ]);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("the minute sweep applies an invitation whose arrival event never came", async () => {
  const { org, attachment } = await invitation();
  await database.db
    .update(schema.attachments)
    .set({ createdAt: sql`now() - interval '5 minutes'` })
    .where(eq(schema.attachments.id, attachment.id));
  expect(await eventsOf(org.id)).toEqual([]);

  const run = await worker.server.getWorker().scheduled({ cron: MINUTE_CRON });
  expect(run.outcome).toBe("ok");
  expect(await eventsOf(org.id)).toEqual([
    { title: "Acme × Studio: kickoff", startsAt: new Date("2026-11-24T15:30:00Z") },
  ]);
  const [part] = await database.db
    .select()
    .from(schema.calendarParts)
    .where(eq(schema.calendarParts.attachmentId, attachment.id));
  expect(part).toMatchObject({ outcome: "applied", method: "REQUEST" });
});

test("an invitation that landed in Junk is recorded and kept off the calendar", async () => {
  const { org, inbox, threadId, messageId, attachment } = await invitation("Junk");
  await postMailEvents(worker, {
    events: [
      {
        type: "message.created",
        orgId: org.id,
        mailboxId: inbox.id,
        threadId,
        messageId,
        folderRole: "junk",
      },
    ],
  });
  const [part] = await until(() =>
    database.db
      .select()
      .from(schema.calendarParts)
      .where(eq(schema.calendarParts.attachmentId, attachment.id)),
  );
  expect(part).toMatchObject({ outcome: "ignored", reason: "junk" });
  expect(await eventsOf(org.id)).toEqual([]);
});
