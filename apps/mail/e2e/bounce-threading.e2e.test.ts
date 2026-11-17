import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, seedMailbox, stored, type TestDb } from "./support/db.ts";
import { logger, otherClient } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let store: PgMailStore;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  const { objects } = await createTestBucket();
  store = new PgMailStore({ db, objects, links });
});

afterAll(async () => {
  await database.teardown();
});

it.each([2, 1])(
  "a bounce joins the conversation of the reply that failed (batch size %i)",
  async (batchSize) => {
    const { box } = await seedMailbox(db);
    const reply = [
      "From: Support <support@example.com>",
      "To: Oriol Grau <oriol@talleresgrau.example.net>",
      "Subject: Re: [#2093] Quote for 40 seats",
      "Message-ID: <3a9f1c7e-5b2d-4e8a-9c6f-0d4b2e8a1c37@example.com>",
      "Date: Mon, 9 Nov 2026 12:30:40 +0000",
      "",
      "The quote is attached.",
      "",
    ].join("\r\n");
    const bounce = readFileSync(
      new URL("../../../fixtures/eml/bounce-dsn-postfix.eml", import.meta.url),
    );
    await otherClient(box, async (client) => {
      await client.append("INBOX", reply, []);
      await client.append("INBOX", bounce, []);
    });

    const connection = new MailboxConnection(box, { store, logger, batchSize });
    await connection.start();
    try {
      const rows = await stored(db, box.id, "INBOX");
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.threadId)).size).toBe(1);
    } finally {
      await connection.stop();
    }
  },
);
