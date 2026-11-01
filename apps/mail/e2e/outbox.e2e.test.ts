import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { deterministicMessageId, OutboxExecutor } from "../src/outbox.ts";
import { PgActionSource, PgMailStore } from "../src/pg-store.ts";
import {
  actionRow,
  asClaimed,
  createTestDatabase,
  enqueue,
  messageRows,
  seedMailbox,
  stored,
  type TestDb,
} from "./support/db.ts";
import { deliver, logger, mailbox, otherClient, purge, waitFor } from "./support/greenmail.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let connections: MailboxConnection[] = [];

async function setup(kind: "personal" | "shared" = "personal") {
  const seeded = await seedMailbox(db, { kind });
  const { box } = seeded;
  const store = new PgMailStore({ db });
  const actions = new PgActionSource({ db });
  const connection = new MailboxConnection(box, { store, logger });
  connections.push(connection);
  const executor = new OutboxExecutor({
    actions,
    logger,
    connection: (id) => (id === box.id ? connection : undefined),
  });
  return { seeded, box, store, actions, connection, executor };
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.teardown();
});

beforeEach(async () => {
  await purge();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

describe("OutboxExecutor against GreenMail", () => {
  it("sends once and files exactly one copy in Sent, even when executed twice", async () => {
    const { seeded, box, actions, connection, executor } = await setup();
    const recipient = mailbox();
    await connection.start();

    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-send-1-${box.id}`,
      payload: {
        from: box.address,
        to: [recipient.address],
        subject: "Re: plans",
        text: "Sounds good.",
        inReplyTo: "<original@outside.test>",
        references: ["<root@outside.test>", "<original@outside.test>"],
      },
    });
    const [claimed] = await actions.claim(1);
    if (!claimed) throw new Error("nothing claimed");

    await executor.execute(claimed);
    // The process died after the work but before `complete` was saved: the row runs again.
    await executor.execute(await asClaimed(db, row.id));

    expect(await actionRow(db, row.id)).toMatchObject({ status: "done", lastError: null });
    const messageId = deterministicMessageId(row.idempotencyKey, box.address);

    const sentCopies = await otherClient(box, async (client) => {
      const lock = await client.getMailboxLock("Sent");
      try {
        return await client.fetchAll("1:*", { uid: true, source: true, flags: true });
      } finally {
        lock.release();
      }
    });
    expect(sentCopies).toHaveLength(1);
    const sentRaw = sentCopies[0]?.source?.toString() ?? "";
    expect(sentRaw).toContain(`Message-ID: ${messageId}`);
    expect(sentRaw).toContain("In-Reply-To: <original@outside.test>");
    expect(sentRaw).toContain("References: <root@outside.test> <original@outside.test>");
    expect(sentCopies[0]?.flags?.has("\\Seen")).toBe(true);

    // The recipient got it once.
    const received = await otherClient(recipient, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await client.search({ header: { "message-id": messageId } }, { uid: true });
      } finally {
        lock.release();
      }
    });
    expect(received).toHaveLength(1);

    // The Sent copy is indexed right away, once, without waiting for the periodic sync.
    const sentRows = await stored(db, box.id, "Sent");
    expect(sentRows.map((r) => r.messageIdHeader)).toEqual([messageId]);
    expect(await messageRows(db, box.id)).toHaveLength(1);
  });

  it("finishes the Sent append without resending when SMTP already accepted", async () => {
    const { seeded, box, actions, connection, executor } = await setup();
    const recipient = mailbox();
    await connection.start();

    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-send-2-${box.id}`,
      payload: { from: box.address, to: [recipient.address], subject: "once", text: "hi" },
    });
    // An earlier attempt got SMTP's OK, then crashed before the IMAP append.
    await actions.claim(1);
    await actions.markSmtpAccepted(row.id);
    await executor.execute(await asClaimed(db, row.id));

    expect((await actionRow(db, row.id)).status).toBe("done");
    const inRecipientInbox = await otherClient(recipient, async (client) => {
      const status = await client.status("INBOX", { messages: true });
      return status ? status.messages : -1;
    });
    expect(inRecipientInbox).toBe(0);
    const inSent = await otherClient(box, async (client) => {
      const status = await client.status("Sent", { messages: true });
      return status ? status.messages : -1;
    });
    expect(inSent).toBe(1);
  });

  it("archives a message and the store follows it to Archive", async () => {
    const { seeded, box, store, connection, executor } = await setup();
    await deliver(box.address, "to archive");
    await connection.start();
    const [message] = await stored(db, box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    const row = await enqueue(db, seeded, {
      kind: "archive",
      idempotencyKey: `idem-archive-1-${box.id}`,
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();

    expect((await actionRow(db, row.id)).status).toBe("done");
    expect(await stored(db, box.id, "INBOX")).toHaveLength(0);
    const archived = await stored(db, box.id, "Archive");
    expect(archived.map((r) => r.subject)).toEqual(["to archive"]);
    // Same row, now located in Archive: a move is not a new message.
    expect(archived[0]?.messageId).toBe(message.messageId);
  });

  it("refuses to touch UIDs whose folder UIDVALIDITY changed", async () => {
    const { seeded, box, connection, executor } = await setup();
    await deliver(box.address, "stale target");
    await connection.start();
    const [message] = await stored(db, box.id, "INBOX");

    const row = await enqueue(db, seeded, {
      kind: "move",
      idempotencyKey: `idem-move-stale-${box.id}`,
      payload: {
        folder: "INBOX",
        uidValidity: "1",
        uids: [message?.uid ?? 1],
        destination: "Trash",
      },
    });
    await executor.drain();

    expect((await actionRow(db, row.id)).status).toBe("failed");
    expect(await stored(db, box.id, "INBOX")).toHaveLength(1);
  });

  it("never changes \\Seen on a shared mailbox", async () => {
    const { seeded, box, store, connection, executor } = await setup("shared");
    await deliver(box.address, "team mail");
    await connection.start();
    const [message] = await stored(db, box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    const row = await enqueue(db, seeded, {
      kind: "mark_read",
      idempotencyKey: `idem-read-shared-${box.id}`,
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();
    expect((await actionRow(db, row.id)).status).toBe("done");

    const flags = await otherClient(box, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const [fetched] = await client.fetchAll(
          String(message.uid),
          { flags: true },
          { uid: true },
        );
        return fetched?.flags;
      } finally {
        lock.release();
      }
    });
    expect(flags?.has("\\Seen")).toBe(false);
  });

  it("marks read on a personal mailbox", async () => {
    const { seeded, box, store, connection, executor } = await setup();
    await deliver(box.address, "personal mail");
    await connection.start();
    const [message] = await stored(db, box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    const row = await enqueue(db, seeded, {
      kind: "mark_read",
      idempotencyKey: `idem-read-personal-${box.id}`,
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();

    expect((await actionRow(db, row.id)).status).toBe("done");
    await waitFor(async () => (await stored(db, box.id, "INBOX"))[0]?.flags.includes("\\Seen"));
  });
});
