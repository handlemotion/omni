import { forMember, schema } from "@omni/db";
import { createMember } from "@omni/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MailboxConnection, type NewMessageEvent } from "../src/mailbox-connection.ts";
import { PgMailStore } from "../src/pg-store.ts";
import { createTestDatabase, messageRows, seedMailbox, stored, type TestDb } from "./support/db.ts";
import { createTestBucket, links } from "./support/objects.ts";
import { deliver, logger, otherClient, waitFor } from "./support/greenmail.ts";

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
    // The reader shows the cid image in the body and only the CSV as a chip, and offers to load
    // the one blocked remote image.
    expect(logo).toMatchObject({ inline: true, contentId: "logo@q3" });
    expect(files.find((f) => f.filename === "report.csv")?.inline).toBe(false);
    const [row] = await messageRows(db, box.id);
    expect(row?.remoteImageCount).toBe(1);
    expect(html).toContain(`src="/api/attachments/${logo?.r2Key.split("/").at(-1)}"`);
    const csv = files.find((f) => f.filename === "report.csv");
    expect(Buffer.from((await objects.get(csv?.r2Key ?? "missing")) ?? []).toString()).toBe(
      "q,revenue\n1,100\n",
    );
  });

  it("streams a large message through temp files and stores what the in-memory path stores", async () => {
    // A 300 KB attachment next to the cid image and HTML of the Q3 report.
    const big = randomBytes(300 * 1024);
    const raw = htmlWithAttachments().replace(
      "--mixed--",
      [
        "--mixed",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename=scan.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        big.toString("base64").replace(/.{76}/g, "$&\r\n"),
        "--mixed--",
      ].join("\r\n"),
    );
    const viaMemory = await seedMailbox(db);
    const viaFile = await seedMailbox(db);
    for (const { box } of [viaMemory, viaFile]) {
      await otherClient(box, (client) => client.append("INBOX", raw, []));
    }
    const spooled = () =>
      readdir(tmpdir()).then((names) => names.filter((n) => n.startsWith("omni-")));
    const before = await spooled();

    await connect(viaMemory.box).start();
    // The real store, noting which path each message came by.
    const paths: string[] = [];
    const noting = Object.create(store) as PgMailStore;
    noting.storeMessage = (mailboxId, fetched) => {
      paths.push(fetched.raw instanceof Uint8Array ? "memory" : "file");
      return store.storeMessage(mailboxId, fetched);
    };
    const streaming = new MailboxConnection(viaFile.box, {
      store: noting,
      logger,
      streamAboveBytes: 64 * 1024,
    });
    connections.push(streaming);
    await streaming.start();

    const read = async (key: string | null | undefined) =>
      Buffer.from((await objects.get(key ?? "missing")) ?? []);
    const [inMemory] = await stored(db, viaMemory.box.id, "INBOX");
    const [streamed] = await stored(db, viaFile.box.id, "INBOX");
    // The exact server bytes, and the same objects and rows either way.
    expect((await read(streamed?.r2Key)).toString()).toBe((await read(inMemory?.r2Key)).toString());
    expect(streamed?.r2Key?.split("/").at(-1)).toBe(inMemory?.r2Key?.split("/").at(-1));
    expect((await read(streamed?.htmlR2Key)).toString()).toBe(
      (await read(inMemory?.htmlR2Key)).toString(),
    );
    expect(streamed?.cleanText).toBe(inMemory?.cleanText);
    const files = async (messageId: string | undefined) =>
      (
        await db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.messageId, messageId ?? ""))
      )
        .map((f) => ({
          ...f,
          id: "",
          orgId: "",
          messageId: "",
          createdAt: null,
          hash: f.r2Key.split("/").at(-1),
          r2Key: "",
        }))
        .toSorted((a, b) => (a.filename ?? "").localeCompare(b.filename ?? ""));
    const streamedFiles = await files(streamed?.messageId);
    expect(streamedFiles).toEqual(await files(inMemory?.messageId));
    expect(streamedFiles.map((f) => [f.filename, f.size])).toEqual([
      ["logo.png", 16],
      ["report.csv", 16],
      ["scan.pdf", big.length],
    ]);
    const pdf = (
      await db
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.messageId, streamed?.messageId ?? ""))
    ).find((f) => f.filename === "scan.pdf");
    expect((await read(pdf?.r2Key)).equals(big)).toBe(true);
    expect(paths).toEqual(["file"]);
    // Every temp file is gone.
    expect(await spooled()).toEqual(before);
  });

  it("stores a forward's original and marks an out-of-office reply as automated", async () => {
    const { box } = await seedMailbox(db);
    const fixture = (name: string) =>
      readFile(new URL(`../../../fixtures/eml/${name}`, import.meta.url));
    await otherClient(box, async (client) => {
      await client.append("INBOX", await fixture("gmail-forward.eml"), []);
      await client.append("INBOX", await fixture("auto-reply-outlook-out-of-office.eml"), []);
    });
    await deliver(box.address, "a person writing");

    await connect(box).start();

    const rows = await messageRows(db, box.id);
    const bySubject = (prefix: string) => rows.find((m) => m.subject.startsWith(prefix));
    expect(bySubject("Fwd: Invoice")?.forwarded).toMatchObject({
      from: expect.stringContaining("billing@northwind.example.net"),
      subject: "Invoice INV-2026-0412 from Northwind Hosting",
      text: expect.stringContaining("is due on November 3, 2026"),
    });
    // An auto-reply must not reopen a conversation or start an SLA; a person's mail must.
    expect(bySubject("Automatic reply")?.automated).toBe(true);
    expect(bySubject("a person writing")).toMatchObject({ automated: false, forwarded: null });
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

  it("merges a reply's early thread into its conversation once the missing parent arrives", async () => {
    const { box, orgId, ownerId } = await seedMailbox(db);
    const merges: unknown[] = [];
    const merging = new PgMailStore({ db, objects, links, onMerged: (m) => merges.push(m) });
    const connection = new MailboxConnection(box, { store: merging, logger, batchSize: 2 });
    connections.push(connection);
    await connection.start();
    const arrive = async (subject: string, reply: Parameters<typeof deliver>[2]) => {
      const seen = new Promise((resolve) => connection.once("message", resolve));
      await deliver(box.address, subject, reply);
      await seen;
    };
    const threadOf = async (header: string) =>
      (await stored(db, box.id, "INBOX")).find((m) => m.messageIdHeader === header)?.threadId;

    // A, then C replying to B, which has not arrived (its References skip A): two threads.
    await arrive("Refund", { messageId: "<a@outside.test>" });
    await arrive("Re: Refund", {
      messageId: "<c@outside.test>",
      inReplyTo: "<b@outside.test>",
      references: ["<b@outside.test>"],
    });
    const first = await threadOf("<a@outside.test>");
    const second = await threadOf("<c@outside.test>");
    expect(first && second && first !== second).toBe(true);
    // Helpdesk state on both halves: the first was resolved, the second assigned with a note.
    await db
      .update(schema.threads)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(schema.threads.id, first ?? ""));
    await db
      .update(schema.threads)
      .set({ assigneeMemberId: ownerId, priority: "high" })
      .where(eq(schema.threads.id, second ?? ""));
    await db.insert(schema.notes).values({
      orgId,
      mailboxId: box.id,
      threadId: second ?? "",
      authorMemberId: ownerId,
      body: "customer called",
    });

    // B links them: it replies to A, and C replies to B.
    await arrive("Re: Refund", { messageId: "<b@outside.test>", inReplyTo: "<a@outside.test>" });

    for (const header of ["<a@outside.test>", "<b@outside.test>", "<c@outside.test>"]) {
      expect(await threadOf(header)).toBe(first);
    }
    const remaining = await db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.mailboxId, box.id));
    expect(remaining.map((t) => t.id)).toEqual([first]);
    expect(remaining[0]).toMatchObject({
      status: "open",
      resolvedAt: null,
      assigneeMemberId: ownerId,
      priority: "high",
    });
    const notes = await db.select().from(schema.notes).where(eq(schema.notes.mailboxId, box.id));
    expect(notes.map((n) => [n.threadId, n.body])).toEqual([[first, "customer called"]]);
    const events = await db
      .select()
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.threadId, first ?? ""));
    expect(events.filter((e) => e.kind === "merged").map((e) => e.data)).toEqual([
      { fromThreadId: second },
    ]);
    expect(merges).toEqual([
      { orgId, mailboxId: box.id, intoThreadId: first, fromThreadIds: [second] },
    ]);
  });

  it("a reply over SMTP brings a done thread back to the inbox of the member who marked it", async () => {
    const { box, orgId, ownerId } = await seedMailbox(db, { kind: "shared" });
    const teammate = await createMember(db, orgId, "teammate");
    await db
      .insert(schema.mailboxAccess)
      .values({ orgId, mailboxId: box.id, memberId: teammate.id });
    const connection = connect(box);
    await connection.start();
    const inbox = async (memberId: string) =>
      (await forMember(db, memberId).listThreads()).map((t) => t.id);

    let arrived = new Promise((resolve) => connection.once("message", resolve));
    await deliver(box.address, "Contract");
    await arrived;
    const [first] = await stored(db, box.id, "INBOX");
    const [thread] = await forMember(db, ownerId).listThreads();
    expect(thread?.id).toBe(first?.threadId);
    await forMember(db, ownerId).setThreadState(thread!.id, {
      doneThrough: thread!.lastMessageAt,
    });
    expect(await inbox(ownerId)).toEqual([]);
    expect(await inbox(teammate.id)).toEqual([thread!.id]);

    // Date headers have one-second precision; the reply must be visibly newer.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    arrived = new Promise((resolve) => connection.once("message", resolve));
    await deliver(box.address, "Re: Contract", { inReplyTo: first!.messageIdHeader });
    await arrived;

    await waitFor(async () => (await stored(db, box.id, "INBOX")).length === 2);
    expect(await inbox(ownerId)).toEqual([thread!.id]);
    const [reopened] = await forMember(db, ownerId).listThreads();
    expect(reopened).toMatchObject({ done: false, messageCount: 2 });
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

  it("is ready as soon as INBOX is in, before a large archive imports", async () => {
    const { box } = await seedMailbox(db);
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Archive");
      for (let i = 0; i < 6; i++) await client.append("Archive", raw({ subject: `old ${i}` }), []);
      await client.append("INBOX", raw({ subject: "new question" }), []);
    });

    const connection = connect(box);
    const order: string[] = [];
    connection.on("message", (event) => order.push(event.folder));
    connection.on("connected", () => order.push("ready"));
    await connection.start();
    await connection.syncAll();

    // Before, the whole mailbox imported first, INBOX last: a big archive kept the inbox empty.
    expect(order).toEqual(["INBOX", "ready", ...Array<string>(6).fill("Archive")]);
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
    // Ready means INBOX is in; the first full pass, which brings Notes, is still running.
    await connection.syncAll();
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
    await connection.syncAll();
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
    await connection.syncAll();
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
