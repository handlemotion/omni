// Deletes made in another mail app reach Omni (ADR 0013: the index converges from IMAP). A message
// deleted on the server goes from Postgres with its thread once a full sync finds it nowhere; a
// message moved to Trash leaves the inbox; a move another app made is never mistaken for a delete.
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, messageRows, seedMailbox, type TestDb } from "./support/db.ts";
import { deliver, logger, otherClient } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";

const { threads } = schema;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let store: PgMailStore;
let connections: MailboxConnection[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  const { objects } = await createTestBucket();
  store = new PgMailStore({ db, objects, links });
});

afterAll(async () => {
  await database.teardown();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

async function connected(kind: "personal" | "shared") {
  const seeded = await seedMailbox(db, { kind });
  const connection = new MailboxConnection(seeded.box, { store, logger });
  connections.push(connection);
  return { ...seeded, connection };
}

/** Delivers each subject, then imports them with one sync. */
async function arrive(connection: MailboxConnection, mail: Parameters<typeof deliver>[]) {
  for (const args of mail) await deliver(...args);
  await connection.start();
  await connection.syncAll();
}

/** Moves (or with no destination, deletes) INBOX messages with this subject, as Apple Mail would. */
async function inOtherApp(
  connection: MailboxConnection,
  subject: string,
  destination: string | null,
) {
  await otherClient(connection.mailbox, async (client) => {
    if (destination) await client.mailboxCreate(destination).catch(() => {});
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ subject }, { uid: true })) || [];
      if (destination) await client.messageMove(uids, destination, { uid: true });
      else await client.messageDelete(uids, { uid: true });
    } finally {
      lock.release();
    }
  });
}

const subjects = async (mailboxId: string) =>
  (await messageRows(db, mailboxId)).map((m) => m.subject).toSorted();

const threadOf = async (mailboxId: string, subject: string) => {
  const message = (await messageRows(db, mailboxId)).find((m) => m.subject === subject);
  if (!message) return null;
  const [thread] = await db.select().from(threads).where(eq(threads.id, message.threadId));
  return thread ?? null;
};

it.for(["personal", "shared"] as const)(
  "a thread deleted in another app leaves the %s mailbox's index; the rest stays",
  async (kind) => {
    const { box, connection } = await connected(kind);
    const parent = `<parent.${box.id}@outside.test>`;
    await arrive(connection, [
      [box.address, "Delete me", { messageId: parent }],
      [box.address, "Re: Delete me", { inReplyTo: parent }],
      [box.address, "Keep me"],
    ]);
    const deleted = await threadOf(box.id, "Delete me");
    expect(deleted).not.toBeNull();

    await inOtherApp(connection, "Delete me", null);
    // The first pass sees the copies gone; the next one finds them nowhere and deletes the rows.
    await connection.syncAll();
    await connection.syncAll();

    expect(await subjects(box.id)).toEqual(["Keep me"]);
    const [gone] = await db.select().from(threads).where(eq(threads.id, deleted!.id));
    expect(gone).toBeUndefined();
  },
);

it("a thread moved to Trash in another app leaves the inbox and keeps its messages", async () => {
  const { box, connection } = await connected("shared");
  await arrive(connection, [[box.address, "Spammy offer"]]);
  expect((await threadOf(box.id, "Spammy offer"))?.archived).toBe(false);

  await inOtherApp(connection, "Spammy offer", "Trash");
  await connection.syncAll();
  await connection.syncAll();

  expect(await subjects(box.id)).toEqual(["Spammy offer"]);
  expect((await threadOf(box.id, "Spammy offer"))?.archived).toBe(true);
});

it("a move seen from INBOX before its destination is synced keeps the same message row", async () => {
  const { box, connection } = await connected("personal");
  await arrive(connection, [[box.address, "Filed elsewhere"]]);
  const [before] = await messageRows(db, box.id);

  await inOtherApp(connection, "Filed elsewhere", "Projects");
  // IDLE-driven INBOX sync: the copy is gone from INBOX and the new folder is not synced yet.
  await connection.syncFolder("INBOX");
  expect(await store.orphanedMessages(box.id)).toEqual([before!.id]);
  await connection.syncAll();
  await connection.syncAll();

  const after = await messageRows(db, box.id);
  expect(after.map((m) => m.id)).toEqual([before!.id]);
});
