// A mailbox that indexes only recent mail (ADR 0045), against GreenMail: what the window holds,
// that mail outside it never looks deleted, that an interrupted first import resumes, and that a
// wiped index rebuilds the same set.
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MailboxConnection, type MailboxConfig } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, messageRows, seedMailbox, stored, type TestDb } from "./support/db.ts";
import { deliver, logger, otherClient, waitFor } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START = new Date(Date.now() - 7 * DAY_MS);
const LONG_AGO = new Date(Date.now() - 30 * DAY_MS);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let objects: Awaited<ReturnType<typeof createTestBucket>>["objects"];
let connections: MailboxConnection[] = [];

function connect(box: MailboxConfig) {
  // A fresh store each time, as a new process has: nothing cached.
  const store = new PgMailStore({ db, objects, links });
  const connection = new MailboxConnection(box, { store, logger, batchSize: 1 });
  connections.push(connection);
  return connection;
}

/** A mailbox with years of mail: `old` messages from a month ago, then `recent` from today. */
async function seedHistory(folders: Record<string, { old: number; recent: number }>) {
  const seeded = await seedMailbox(db);
  const box: MailboxConfig = { ...seeded.box, syncSince: WINDOW_START };
  await otherClient(box, async (client) => {
    for (const [folder, { old, recent }] of Object.entries(folders)) {
      if (folder !== "INBOX") await client.mailboxCreate(folder);
      for (let i = 0; i < old; i++) await append(client, folder, `${folder} old ${i}`, LONG_AGO);
      for (let i = 0; i < recent; i++) await append(client, folder, `${folder} recent ${i}`);
    }
  });
  return box;
}

type Client = Parameters<Parameters<typeof otherClient>[1]>[0];

/** Files a message as Gmail holds it: the server's date for it is `date`, not now. */
async function append(client: Client, folder: string, subject: string, date = new Date()) {
  const raw = [
    "From: someone@outside.test",
    "To: me@omni.test",
    `Subject: ${subject}`,
    `Message-ID: <${subject.replaceAll(" ", "-")}-${crypto.randomUUID()}@outside.test>`,
    `Date: ${date.toUTCString()}`,
    "",
    `body of ${subject}`,
    "",
  ].join("\r\n");
  await client.append(folder, raw, [], date);
}

const subjects = async (boxId: string) =>
  (await messageRows(db, boxId)).map((m) => m.subject).toSorted();

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  ({ objects } = await createTestBucket());
});

afterAll(async () => {
  await database.teardown();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

it("indexes only mail inside the window, keeps it across syncs, and takes everything that arrives later", async () => {
  const box = await seedHistory({
    INBOX: { old: 6, recent: 3 },
    Archive: { old: 5, recent: 1 },
  });
  const expected = [
    "Archive recent 0",
    "INBOX recent 0",
    "INBOX recent 1",
    "INBOX recent 2",
  ].toSorted();

  const connection = connect(box);
  await connection.start();
  // Ready on the recent INBOX alone: none of the 6 old messages was fetched.
  expect((await stored(db, box.id, "INBOX")).map((m) => m.uid)).toEqual([7, 8, 9]);
  await connection.syncAll();
  expect(await subjects(box.id)).toEqual(expected);

  // Two more full passes (the second prunes what the first found missing): mail below the
  // window was never listed, and mail inside it is still there. Nothing looked deleted.
  await connection.syncAll();
  await connection.syncAll();
  expect(await subjects(box.id)).toEqual(expected);

  // New mail, and an old conversation moved back into INBOX in Gmail: both are indexed.
  await deliver(box.address, "arrives later");
  await otherClient(box, (client) => append(client, "INBOX", "old, moved back in", LONG_AGO));
  await connection.syncFolder("INBOX");
  expect(await subjects(box.id)).toEqual(
    [...expected, "arrives later", "old, moved back in"].toSorted(),
  );

  // A delete inside the window still converges (ADR 0013), with the old mail still unlisted.
  await otherClient(box, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageDelete("8", { uid: true });
    } finally {
      lock.release();
    }
  });
  await connection.syncAll();
  await connection.syncAll();
  expect(await subjects(box.id)).toEqual(
    [...expected, "arrives later", "old, moved back in"]
      .filter((subject) => subject !== "INBOX recent 1")
      .toSorted(),
  );
});

it("resumes an interrupted first import where it stopped, and a wiped index rebuilds the same mail", async () => {
  const box = await seedHistory({ INBOX: { old: 4, recent: 5 } });
  const recent = [0, 1, 2, 3, 4].map((n) => `INBOX recent ${n}`);

  // The process stops after the second message of the first import (batches of one).
  const first = connect(box);
  let imported = 0;
  first.on("message", () => {
    if (++imported === 2) void first.stop();
  });
  await first.start();
  await first.stop();
  expect(first.isReady).toBe(false);
  expect(await subjects(box.id)).toEqual(["INBOX recent 3", "INBOX recent 4"]);

  // The next start fetches the three that are missing, not the two it has, and nothing older.
  const second = connect(box);
  const fetched: number[] = [];
  second.on("message", (event) => fetched.push(event.uid));
  await second.start();
  expect(fetched).toEqual([7, 6, 5]);
  expect(await subjects(box.id)).toEqual(recent);
  await second.stop();

  // Postgres loses the index. The window comes from the server, so the rebuild is the same.
  await db.delete(schema.threads).where(eq(schema.threads.mailboxId, box.id));
  await db.delete(schema.mailboxFolders).where(eq(schema.mailboxFolders.mailboxId, box.id));
  expect(await subjects(box.id)).toEqual([]);
  const rebuilt = connect(box);
  await rebuilt.start();
  await waitFor(async () => (await subjects(box.id)).length === recent.length);
  await rebuilt.syncAll();
  expect(await subjects(box.id)).toEqual(recent);
});
