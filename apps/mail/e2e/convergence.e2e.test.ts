// Spec, "Sync rules": Purelymail is the source of truth and Postgres is an index a full re-sync
// rebuilds. This builds an index the way it grows in production (mail arriving one message at a
// time over IDLE, actions from Omni through the outbox, a change made in Apple Mail), wipes the
// mailbox's index, re-syncs from scratch, and requires the same index back. The re-sync sees the
// mail in a different order (history imports newest first, INBOX last), which is what makes this
// worth testing.
import { enqueueAction, forMember, schema, setThreadArchived, threadActionTargets } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { OutboxExecutor } from "../src/outbox.ts";
import { PgActionSource, PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, seedMailbox, type TestDb } from "./support/db.ts";
import { deliver, logger, mailbox, otherClient, waitFor } from "./support/greenmail.ts";
import { createTestBucket, links } from "./support/objects.ts";

const { mailboxFolders, messageLocations, messages, threadState, threads } = schema;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let objects: Awaited<ReturnType<typeof createTestBucket>>["objects"];
let connections: MailboxConnection[] = [];

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

/** A process with nothing cached: its own store and connection. */
function startService(box: Awaited<ReturnType<typeof seedMailbox>>["box"]) {
  const store = new PgMailStore({ db, objects, links });
  const connection = new MailboxConnection(box, { store, logger, batchSize: 3 });
  connections.push(connection);
  const actions = new PgActionSource({ db });
  const executor = new OutboxExecutor({
    actions,
    logger,
    connection: (id) => (id === box.id ? connection : undefined),
  });
  /** Runs every queued action once, as the outbox loop would. */
  const drainOutbox = async () => {
    for (let claimed = await actions.claim(10); claimed.length; claimed = await actions.claim(10)) {
      for (const action of claimed) await executor.execute(action);
    }
  };
  return { connection, drainOutbox };
}

/**
 * The index as the apps see it, with nothing that differs between two builds of the same mail
 * (row ids): threads as sets of Message-IDs with their read and archive state, every IMAP copy
 * with its flags, and every folder's sync position.
 */
async function snapshot(mailboxId: string, memberId: string) {
  const rows = await db
    .select({
      threadId: threads.id,
      archived: threads.archived,
      lastMessageAt: threads.lastMessageAt,
      read: threadState.read,
      header: messages.messageIdHeader,
    })
    .from(threads)
    .innerJoin(messages, eq(messages.threadId, threads.id))
    .leftJoin(
      threadState,
      and(eq(threadState.threadId, threads.id), eq(threadState.memberId, memberId)),
    )
    .where(eq(threads.mailboxId, mailboxId));
  const byThread = new Map<
    string,
    { messages: string[]; archived: boolean; read: boolean; lastMessageAt: string }
  >();
  for (const row of rows) {
    const thread = byThread.get(row.threadId) ?? {
      messages: [],
      archived: row.archived,
      read: row.read ?? false,
      lastMessageAt: row.lastMessageAt.toISOString(),
    };
    thread.messages.push(row.header);
    byThread.set(row.threadId, thread);
  }
  const threadList = [...byThread.values()]
    .map((t) => ({ ...t, messages: t.messages.toSorted() }))
    .toSorted((a, b) => (a.messages[0] ?? "").localeCompare(b.messages[0] ?? ""));

  const copies = await db
    .select({
      folder: mailboxFolders.path,
      uid: messageLocations.imapUid,
      flags: messageLocations.flags,
      header: messages.messageIdHeader,
    })
    .from(messageLocations)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .innerJoin(messages, eq(messages.id, messageLocations.messageId))
    .where(eq(messageLocations.mailboxId, mailboxId))
    .orderBy(asc(mailboxFolders.path), asc(messageLocations.imapUid));

  const folders = await db
    .select({
      path: mailboxFolders.path,
      role: mailboxFolders.role,
      uidvalidity: mailboxFolders.uidvalidity,
      uidnext: mailboxFolders.uidnext,
      highestModseq: mailboxFolders.highestModseq,
    })
    .from(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, mailboxId))
    .orderBy(asc(mailboxFolders.path));

  return { threads: threadList, copies, folders };
}

it("a full re-sync after losing the index rebuilds the same threads, read and archive state", async () => {
  const seeded = await seedMailbox(db);
  const { box, ownerId } = seeded;
  const live = startService(box);
  await live.connection.start();

  const id = (name: string) => `<${name}.${box.id}@outside.test>`;
  // Mail arrives one message at a time, oldest first, each indexed before the next.
  const arrive = async (
    subject: string,
    messageId: string,
    reply: { inReplyTo?: string; references?: string[] } = {},
  ) => {
    const seen = new Promise((resolve) => live.connection.once("message", resolve));
    await deliver(box.address, subject, { messageId, ...reply });
    await seen;
  };
  await arrive("Lunch?", id("lunch-1"));
  await arrive("Re: Lunch?", id("lunch-2"), {
    inReplyTo: id("lunch-1"),
    references: [id("lunch-1")],
  });
  // Copied in mid-thread: the first message we have replies to one we never saw.
  await arrive("Re: Budget", id("budget-2"), {
    inReplyTo: id("budget-1"),
    references: [id("budget-1")],
  });
  await arrive("Re: Budget", id("budget-3"), {
    inReplyTo: id("budget-2"),
    references: [id("budget-1"), id("budget-2")],
  });
  // Two people answer the same message.
  await arrive("Offsite", id("offsite-1"));
  await arrive("Re: Offsite", id("offsite-2"), {
    inReplyTo: id("offsite-1"),
    references: [id("offsite-1")],
  });
  await arrive("Re: Offsite", id("offsite-3"), {
    inReplyTo: id("offsite-1"),
    references: [id("offsite-1")],
  });
  await arrive("Newsletter", id("news-1"));

  const threadOf = async (header: string) => {
    const [row] = await db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.mailboxId, box.id), eq(messages.messageIdHeader, header)));
    if (!row) throw new Error(`${header} is not indexed`);
    return row.threadId;
  };
  // What the Worker's routes write: the row first, then one outbox action per folder.
  const enqueueFor = async (threadId: string, kind: "archive" | "mark_read", key: string) => {
    const found = await threadActionTargets(db, ownerId, threadId);
    for (const { role, ...target } of found?.targets ?? []) {
      if (kind === "archive" && (role === "archive" || role === "trash")) continue;
      await enqueueAction(db, {
        orgId: seeded.orgId,
        mailboxId: box.id,
        memberId: ownerId,
        kind,
        payload: target,
        idempotencyKey: `${key}:${target.folder}`,
      });
    }
  };

  // Omni replies in the lunch thread: SMTP, then a copy appended to Sent.
  const recipient = mailbox();
  await enqueueAction(db, {
    orgId: seeded.orgId,
    mailboxId: box.id,
    memberId: ownerId,
    kind: "send",
    idempotencyKey: `reply-${box.id}`,
    payload: {
      from: box.address,
      to: [recipient.address],
      subject: "Re: Lunch?",
      text: "Noon works.",
      inReplyTo: id("lunch-2"),
      references: [id("lunch-1"), id("lunch-2")],
    },
  });
  await live.drainOutbox();
  // Omni marks the lunch thread read and archives the offsite thread.
  const lunch = await threadOf(id("lunch-1"));
  await forMember(db, ownerId).setThreadState(lunch, { read: true });
  await enqueueFor(lunch, "mark_read", `read-${box.id}`);
  const offsite = await threadOf(id("offsite-1"));
  await setThreadArchived(db, ownerId, offsite, true);
  await enqueueFor(offsite, "archive", `archive-${box.id}`);
  await live.drainOutbox();
  // Apple Mail reads the budget thread.
  await otherClient(box, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ subject: "Budget" }, { uid: true });
      await client.messageFlagsAdd(uids || [], ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  });
  // The periodic folder sync.
  await live.connection.syncAll();

  const before = await snapshot(box.id, ownerId);
  const sentReply = before.copies.find((c) => c.folder === "Sent")?.header;
  expect(sentReply).toBeDefined();
  // The live index is right to begin with, per the spec's rules.
  expect(
    before.threads.map(({ messages: headers, read, archived }) => ({
      messages: headers,
      read,
      archived,
    })),
  ).toEqual(
    [
      { messages: [id("budget-2"), id("budget-3")], read: true, archived: false },
      { messages: [id("lunch-1"), id("lunch-2"), sentReply], read: true, archived: false },
      { messages: [id("news-1")], read: false, archived: false },
      {
        messages: [id("offsite-1"), id("offsite-2"), id("offsite-3")],
        read: false,
        archived: true,
      },
    ]
      .map((t) => ({ ...t, messages: t.messages.toSorted() }))
      .toSorted((a, b) => (a.messages[0] ?? "").localeCompare(b.messages[0] ?? "")),
  );

  // Postgres loses the mailbox's index: threads (with their messages, copies and per-member
  // state) and folders (with their sync positions). The mailbox, its members and the outbox stay.
  await live.connection.stop();
  await db.delete(threads).where(eq(threads.mailboxId, box.id));
  await db.delete(mailboxFolders).where(eq(mailboxFolders.mailboxId, box.id));
  expect((await snapshot(box.id, ownerId)).threads).toEqual([]);

  const rebuilt = startService(box);
  await rebuilt.connection.start();

  await waitFor(
    async () => (await snapshot(box.id, ownerId)).copies.length >= before.copies.length,
  );
  expect(await snapshot(box.id, ownerId)).toEqual(before);
});
