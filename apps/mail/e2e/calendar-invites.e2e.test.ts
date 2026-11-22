import { readFileSync } from "node:fs";
import { join } from "node:path";
import { calendarArrivals, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MailboxConnection, type NewMessageEvent } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, stored, seedMailbox, type TestDb } from "./support/db.ts";
import { createTestBucket, links } from "./support/objects.ts";
import { logger } from "./support/greenmail.ts";

const invite = readFileSync(
  join(import.meta.dirname, "../../../fixtures/ics/google-invite.ics"),
  "utf8",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let objects: Awaited<ReturnType<typeof createTestBucket>>["objects"];
let store: PgMailStore;
let connection: MailboxConnection | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  ({ objects } = await createTestBucket());
  store = new PgMailStore({ db, objects, links });
});

afterAll(() => database.teardown());
afterEach(() => connection?.stop());

it("an invitation delivered over SMTP is stored with its text/calendar part, bytes and all", async () => {
  const { box } = await seedMailbox(db);
  connection = new MailboxConnection(box, { store, logger, batchSize: 2 });
  await connection.start();
  const seen = new Promise<NewMessageEvent>((resolve) => connection?.once("message", resolve));

  const transport = createTransport({
    host: process.env.GREENMAIL_HOST ?? "localhost",
    port: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
    secure: false,
  });
  await transport.sendMail({
    from: "Ana Ruiz <ana@acme.example>",
    to: box.address,
    subject: "Invitation: Acme × Studio: kickoff",
    text: "Ana Ruiz has invited you to Acme × Studio: kickoff.",
    icalEvent: { method: "REQUEST", content: invite },
  });
  transport.close();
  await seen;

  const [message] = await stored(db, box.id, "INBOX");
  const files = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.messageId, message?.messageId ?? ""));
  const calendar = files.filter((file) =>
    ["text/calendar", "application/ics"].includes(file.mimeType),
  );
  expect(calendar.map((file) => file.mimeType).toSorted()).toEqual([
    "application/ics",
    "text/calendar",
  ]);
  for (const file of calendar) {
    const bytes = Buffer.from((await objects.get(file.r2Key)) ?? []).toString();
    expect(bytes.replaceAll("\r\n", "\n")).toBe(invite.replaceAll("\r\n", "\n"));
  }
  const parts = await calendarArrivals(db, [message?.messageId ?? ""]);
  expect(parts.map((part) => part.id).toSorted()).toEqual(calendar.map((f) => f.id).toSorted());
  expect(parts[0]).toMatchObject({
    mailboxId: box.id,
    mailboxAddress: box.address,
    fromAddress: "ana@acme.example",
    folderRoles: ["inbox"],
  });
});
