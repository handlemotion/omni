import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailboxConnection, type NewMessageEvent } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, messageRows, seedMailbox, stored, type TestDb } from "./support/db.ts";
import { createTestBucket, links } from "./support/objects.ts";
import { deliver, logger, otherClient } from "./support/greenmail.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let objects: Awaited<ReturnType<typeof createTestBucket>>["objects"];
let store: PgMailStore;
let connections: MailboxConnection[] = [];

function connect(box: Awaited<ReturnType<typeof seedMailbox>>["box"]) {
  const connection = new MailboxConnection(box, { store, logger, batchSize: 2 });
  connections.push(connection);
  return connection;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  ({ objects } = await createTestBucket());
  store = new PgMailStore({ db, objects, links });
});

afterAll(async () => {
  await database.teardown();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

describe("sync into Postgres against GreenMail", () => {
  it("indexes new mail from IDLE with a thread and clean text in under 5 seconds", async () => {
    const { box } = await seedMailbox(db);
    const connection = connect(box);
    await connection.start();

    const seen = new Promise<NewMessageEvent>((resolve) => connection.once("message", resolve));
    const sentAt = Date.now();
    await deliver(box.address, "hello over idle");
    await seen;

    expect(Date.now() - sentAt).toBeLessThan(5_000);
    const [message] = await stored(db, box.id, "INBOX");
    expect(message).toMatchObject({
      subject: "hello over idle",
      cleanText: "body of hello over idle",
    });
    expect(message?.threadId).toBeTruthy();
    // The object store holds the exact bytes from the server.
    const rawObject = await objects.get(message?.r2Key ?? "missing");
    expect(Buffer.from(rawObject ?? []).toString()).toContain("Subject: hello over idle");
  });

  it("stores sanitized HTML and attachments, mapping cid images to attachment URLs", async () => {
    const { box } = await seedMailbox(db);
    await otherClient(box, (client) => client.append("INBOX", htmlWithAttachments(), []));

    await connect(box).start();

    const [message] = await stored(db, box.id, "INBOX");
    const html = Buffer.from((await objects.get(message?.htmlR2Key ?? "missing")) ?? []).toString();
    expect(html).toContain("Quarterly numbers");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    // Remote images are blocked behind the proxy; the cid image points at its attachment.
    expect(html).toContain(
      `data-omni-src="/api/image-proxy?url=${encodeURIComponent("https://tracker.test/p.gif")}"`,
    );
    const files = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.messageId, message?.messageId ?? ""));
    expect(files.map((f) => f.filename).toSorted()).toEqual(["logo.png", "report.csv"]);
    const logo = files.find((f) => f.filename === "logo.png");
    expect(html).toContain(`src="/api/attachments/${logo?.r2Key.split("/").at(-1)}"`);
    const csv = files.find((f) => f.filename === "report.csv");
    expect(Buffer.from((await objects.get(csv?.r2Key ?? "missing")) ?? []).toString()).toBe(
      "q,revenue\n1,100\n",
    );
  });

  it("joins a reply to its thread by In-Reply-To, and a new subject starts a new thread", async () => {
    const { box } = await seedMailbox(db);
    await otherClient(box, async (client) => {
      await client.append("INBOX", raw({ subject: "Lunch?", id: "<lunch-1@outside.test>" }), []);
      await client.append(
        "INBOX",
        raw({
          subject: "Re: Lunch?",
          id: "<lunch-2@outside.test>",
          inReplyTo: "<lunch-1@outside.test>",
          body: "Sure, noon.\r\n\r\nOn Mon, someone wrote:\r\n> Lunch?",
        }),
        [],
      );
      await client.append("INBOX", raw({ subject: "Invoice", id: "<inv@outside.test>" }), []);
    });

    await connect(box).start();

    const rows = await stored(db, box.id, "INBOX");
    const byId = new Map(rows.map((r) => [r.messageIdHeader, r]));
    expect(byId.get("<lunch-2@outside.test>")?.threadId).toBe(
      byId.get("<lunch-1@outside.test>")?.threadId,
    );
    expect(byId.get("<inv@outside.test>")?.threadId).not.toBe(
      byId.get("<lunch-1@outside.test>")?.threadId,
    );
    // Quoted history is cut from clean_text; the raw message keeps it.
    expect(byId.get("<lunch-2@outside.test>")?.cleanText).toBe("Sure, noon.");
  });

  it("resumes after a restart without re-importing or duplicating rows", async () => {
    const { box } = await seedMailbox(db);
    for (const n of [1, 2, 3]) await deliver(box.address, `before ${n}`);

    const first = connect(box);
    await first.start();
    expect(await stored(db, box.id, "INBOX")).toHaveLength(3);
    await first.stop();

    // Mail that arrives while the service is down.
    for (const n of [4, 5]) await deliver(box.address, `while down ${n}`);

    // A new process: a fresh store with nothing cached.
    store = new PgMailStore({ db, objects, links });
    const second = connect(box);
    let fetchedAgain = 0;
    second.on("message", () => fetchedAgain++);
    await second.start();

    expect(fetchedAgain).toBe(2);
    expect(await stored(db, box.id, "INBOX")).toHaveLength(5);
    expect(await messageRows(db, box.id)).toHaveLength(5);
  });

  it("imports history newest first in batches", async () => {
    const { box } = await seedMailbox(db);
    for (const n of [1, 2, 3, 4, 5]) await deliver(box.address, `history ${n}`);

    await connect(box).start();

    // Rows in insertion order; subjects say which message each one is.
    const order = (await messageRows(db, box.id)).map((m) => Number(m.subject.split(" ")[1]));
    expect(order).toHaveLength(5);
    // batchSize 2: batches {5,4}, {3,2}, {1}; within a batch the server picks the order.
    expect(Math.min(...order.slice(0, 2))).toBeGreaterThan(Math.max(...order.slice(2)));
    expect(order.at(-1)).toBe(1);
  });

  it("stores a message filed in two folders once, and later syncs fetch neither copy", async () => {
    const { box } = await seedMailbox(db);
    const note = raw({ subject: "note to self", id: "<self-note@omni.test>" });
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Notes");
      await client.append("INBOX", note, []);
      await client.append("Notes", note, []);
    });

    const connection = connect(box);
    await connection.start();
    let refetched = 0;
    connection.on("message", () => refetched++);
    await connection.syncAll();

    expect(refetched).toBe(0);
    expect(await messageRows(db, box.id)).toHaveLength(1);
    const [inInbox] = await stored(db, box.id, "INBOX");
    const [inNotes] = await stored(db, box.id, "Notes");
    expect(inInbox?.messageId).toBe(inNotes?.messageId);
  });

  it("picks up a flag change made by another IMAP client on folder sync", async () => {
    const { box } = await seedMailbox(db);
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Projects");
      await client.append("Projects", raw({ subject: "needs a flag" }), []);
    });

    const connection = connect(box);
    await connection.start();
    const [before] = await stored(db, box.id, "Projects");
    expect(before?.flags).toEqual([]);

    await otherClient(box, async (client) => {
      const lock = await client.getMailboxLock("Projects");
      try {
        await client.messageFlagsAdd(String(before?.uid), ["\\Seen", "\\Flagged"], { uid: true });
      } finally {
        lock.release();
      }
    });

    const result = await connection.syncFolder("Projects");
    expect(result.flagsChanged).toBe(1);
    expect((await stored(db, box.id, "Projects"))[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
  });

  it("re-syncs a folder from scratch when its UIDVALIDITY changes, without duplicate rows", async () => {
    const { box } = await seedMailbox(db);
    const kept = raw({ subject: "kept receipt", id: "<kept-receipt@outside.test>" });
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Receipts");
      await client.append("Receipts", kept, []);
      await client.append("Receipts", raw({ subject: "old receipt" }), []);
    });

    const connection = connect(box);
    await connection.start();
    expect(await stored(db, box.id, "Receipts")).toHaveLength(2);
    const oldValidity = (await store.getSyncPosition(box.id, "Receipts"))?.uidValidity;

    // GreenMail derives UIDVALIDITY from the clock in seconds; let it tick so the new one differs.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // Delete and recreate the folder: same path, new UIDVALIDITY, UIDs start over.
    await otherClient(box, async (client) => {
      await client.mailboxDelete("Receipts");
      await client.mailboxCreate("Receipts");
      await client.append("Receipts", raw({ subject: "new receipt" }), []);
      await client.append("Receipts", kept, []);
    });

    const result = await connection.syncFolder("Receipts");
    expect(result.reset).toBe(true);
    const subjects = (await stored(db, box.id, "Receipts")).map((r) => r.subject).toSorted();
    expect(subjects).toEqual(["kept receipt", "new receipt"]);
    // The kept message is the same row; the reset re-linked it instead of re-inserting.
    const rows = await messageRows(db, box.id);
    expect(rows.filter((r) => r.subject === "kept receipt")).toHaveLength(1);
    const position = await store.getSyncPosition(box.id, "Receipts");
    expect(position?.uidValidity).not.toBe(oldValidity);
  });
});

function htmlWithAttachments(): string {
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  return [
    "From: finance@outside.test",
    "To: me@omni.test",
    "Subject: Q3 report",
    "Message-ID: <q3-report@outside.test>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed"',
    "",
    "--mixed",
    'Content-Type: multipart/related; boundary="related"',
    "",
    "--related",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Quarterly numbers</p><img src="cid:logo@q3"><img src="https://tracker.test/p.gif">',
    '<script>alert(1)</script><img src="x" onerror="alert(2)">',
    "--related",
    "Content-Type: image/png",
    "Content-ID: <logo@q3>",
    "Content-Disposition: inline; filename=logo.png",
    "Content-Transfer-Encoding: base64",
    "",
    b64("not really a png"),
    "--related--",
    "--mixed",
    "Content-Type: text/csv",
    "Content-Disposition: attachment; filename=report.csv",
    "Content-Transfer-Encoding: base64",
    "",
    b64("q,revenue\n1,100\n"),
    "--mixed--",
    "",
  ].join("\r\n");
}

let counter = 0;

function raw(input: { subject: string; id?: string; inReplyTo?: string; body?: string }): string {
  return [
    "From: someone@outside.test",
    "To: me@omni.test",
    `Subject: ${input.subject}`,
    `Message-ID: ${input.id ?? `<m-${Date.now()}-${counter++}@outside.test>`}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "",
    input.body ?? `body of ${input.subject}`,
    "",
  ].join("\r\n");
}
