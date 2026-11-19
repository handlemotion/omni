import { createHash, randomBytes } from "node:crypto";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { PgMailStore, type PrunedThreads } from "../src/pg-store.ts";
import { createTestDatabase, messageRows, seedMailbox, type TestDb } from "./support/db.ts";
import { deliver, logger, otherClient } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";

const { mailboxFolders, threads } = schema;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let store: PgMailStore;
let connections: MailboxConnection[] = [];
const pruned: PrunedThreads[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  const { objects } = await createTestBucket();
  store = new PgMailStore({ db, objects, links, onPruned: (event) => pruned.push(event) });
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

async function arrive(connection: MailboxConnection, mail: Parameters<typeof deliver>[]) {
  for (const args of mail) await deliver(...args);
  await connection.start();
  await connection.syncAll();
}

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
    await connection.syncAll();
    await connection.syncAll();

    expect(await subjects(box.id)).toEqual(["Keep me"]);
    const [gone] = await db.select().from(threads).where(eq(threads.id, deleted!.id));
    expect(gone).toBeUndefined();
  },
);

it("deleting the latest reply in another app reports its thread, so the Worker re-summarizes", async () => {
  const { box, connection } = await connected("shared");
  const parent = `<order.${box.id}@outside.test>`;
  await arrive(connection, [
    [box.address, "Order 7", { messageId: parent }],
    [box.address, "Re: Order 7 cancel it", { inReplyTo: parent }],
  ]);
  const thread = await threadOf(box.id, "Order 7");

  await inOtherApp(connection, "cancel it", null);
  await connection.syncAll();
  await connection.syncAll();

  expect(await subjects(box.id)).toEqual(["Order 7"]);
  expect(pruned.filter((p) => p.mailboxId === box.id)).toEqual([
    { orgId: thread!.orgId, mailboxId: box.id, threadIds: [thread!.id] },
  ]);
  const queued = await db
    .select({ event: schema.pendingMailEvents.event })
    .from(schema.pendingMailEvents)
    .where(eq(schema.pendingMailEvents.mailboxId, box.id));
  expect(queued.map((row) => row.event)).toEqual([
    { type: "messages.pruned", orgId: thread!.orgId, mailboxId: box.id, threadIds: [thread!.id] },
  ]);
});

it("a Message-ID too long to index still imports, threads its reply, and lets deletes prune", async () => {
  const { box, connection } = await connected("shared");
  const huge = `<${randomBytes(1500).toString("hex")}.${box.id}@outside.test>`;
  await arrive(connection, [
    [box.address, "Huge id", { messageId: huge }],
    [box.address, "Re: Huge id", { inReplyTo: huge }],
    [box.address, "Delete me later"],
  ]);
  expect(await subjects(box.id)).toEqual(["Delete me later", "Huge id", "Re: Huge id"]);
  expect((await threadOf(box.id, "Re: Huge id"))?.id).toBe((await threadOf(box.id, "Huge id"))?.id);

  await inOtherApp(connection, "Delete me later", null);
  await connection.syncAll();
  await connection.syncAll();

  expect(await subjects(box.id)).toEqual(["Huge id", "Re: Huge id"]);
});

const hashedId = (id: string) =>
  `<${createHash("sha256").update(id).digest("hex").slice(0, 40)}@omni.invalid>`;

it.for([
  ["raw, compressed into the index", `<${"y".repeat(3000)}@outside.test>`, (id: string) => id],
  ["hashed, by the 998-byte rule", `<${randomBytes(750).toString("hex")}@outside.test>`, hashedId],
] as const)(
  "a long Message-ID an earlier version stored %s is found again, not imported twice",
  async ([, long, storedAs]) => {
    const { box, connection } = await connected("shared");
    await arrive(connection, [[box.address, "Stored long ago", { messageId: long }]]);
    const [row] = await messageRows(db, box.id);
    await db
      .update(schema.messages)
      .set({ messageIdHeader: storedAs(long) })
      .where(eq(schema.messages.id, row!.id));

    await otherClient(connection.mailbox, async (client) => {
      await client.mailboxCreate("Archive").catch(() => {});
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageCopy("1:*", "Archive", { uid: true });
      } finally {
        lock.release();
      }
    });
    await connection.syncAll();

    expect((await messageRows(db, box.id)).map((m) => m.messageIdHeader)).toEqual([storedAs(long)]);
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

it("a thread in Junk leaves the inbox once a re-sync first detects Junk as junk", async () => {
  const { box, connection } = await connected("shared");
  await arrive(connection, [[box.address, "Cheap watches"]]);
  await inOtherApp(connection, "Cheap watches", "Junk");
  await connection.syncAll();
  const junk = and(eq(mailboxFolders.mailboxId, box.id), eq(mailboxFolders.path, "Junk"));
  await db.update(mailboxFolders).set({ role: "other" }).where(junk);
  const thread = await threadOf(box.id, "Cheap watches");
  await db.update(threads).set({ archived: false }).where(eq(threads.id, thread!.id));

  await connection.syncAll();

  const [folder] = await db.select().from(mailboxFolders).where(junk);
  expect(folder?.role).toBe("junk");
  expect((await threadOf(box.id, "Cheap watches"))?.archived).toBe(true);
});

it("a move seen from INBOX before its destination is synced keeps the same message row", async () => {
  const { box, connection } = await connected("personal");
  await arrive(connection, [[box.address, "Filed elsewhere"]]);
  const [before] = await messageRows(db, box.id);

  await inOtherApp(connection, "Filed elsewhere", "Projects");
  await connection.syncFolder("INBOX");
  expect(await store.orphanedMessages(box.id)).toEqual([before!.id]);
  await connection.syncAll();
  await connection.syncAll();

  const after = await messageRows(db, box.id);
  expect(after.map((m) => m.id)).toEqual([before!.id]);
});
