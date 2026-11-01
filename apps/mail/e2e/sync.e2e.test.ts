import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxConnection, type NewMessageEvent } from "../src/mailbox-connection.ts";
import { deliver, logger, mailbox, otherClient, purge } from "./support/greenmail.ts";
import { MemoryStore } from "./support/memory-store.ts";

let connections: MailboxConnection[] = [];

function connect(box: ReturnType<typeof mailbox>, store: MemoryStore) {
  const connection = new MailboxConnection(box, { store, logger, batchSize: 2 });
  connections.push(connection);
  return connection;
}

beforeEach(async () => {
  await purge();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

describe("MailboxConnection against GreenMail", () => {
  it("delivers new mail through IDLE in under 5 seconds", async () => {
    const box = mailbox();
    const store = new MemoryStore();
    const connection = connect(box, store);
    await connection.start();

    const seen = new Promise<NewMessageEvent>((resolve) => connection.once("message", resolve));
    const sentAt = Date.now();
    await deliver(box.address, "hello over idle");
    const event = await seen;

    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(event).toMatchObject({ folder: "INBOX", role: "inbox" });
    const [stored] = store.list(box.id, "INBOX");
    expect(Buffer.from(stored?.raw ?? []).toString()).toContain("Subject: hello over idle");
  });

  it("resumes from the saved sync position after a restart without re-importing", async () => {
    const box = mailbox();
    const store = new MemoryStore();
    for (const n of [1, 2, 3]) await deliver(box.address, `before ${n}`);

    const first = connect(box, store);
    await first.start();
    expect(store.list(box.id, "INBOX")).toHaveLength(3);
    await first.stop();

    // Mail that arrives while the service is down.
    for (const n of [4, 5]) await deliver(box.address, `while down ${n}`);

    const second = connect(box, store);
    await second.start();

    const uids = store.list(box.id, "INBOX").map((m) => m.uid);
    expect(uids).toHaveLength(5);
    expect(new Set(uids).size).toBe(5);
    // Each message was fetched and stored exactly once across both runs.
    expect(store.created.filter((c) => c.folder === "INBOX")).toHaveLength(5);
  });

  it("imports history newest first in batches", async () => {
    const box = mailbox();
    const store = new MemoryStore();
    for (const n of [1, 2, 3, 4, 5]) await deliver(box.address, `history ${n}`);

    await connect(box, store).start();

    const order = store.created.map((c) => c.uid);
    expect(order).toHaveLength(5);
    // batchSize 2: batches {5,4}, {3,2}, {1}; within a batch the server picks the order.
    expect(Math.min(...order.slice(0, 2))).toBeGreaterThan(Math.max(...order.slice(2)));
    expect(order.at(-1)).toBe(Math.min(...order));
  });

  it("picks up a flag change made by another IMAP client on folder sync", async () => {
    const box = mailbox();
    const store = new MemoryStore();
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Projects");
      await client.append("Projects", rawMessage("needs a flag"), []);
    });

    const connection = connect(box, store);
    await connection.start();
    const [before] = store.list(box.id, "Projects");
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
    expect(store.list(box.id, "Projects")[0]?.flags).toEqual(["\\Flagged", "\\Seen"]);
  });

  it("re-syncs a folder from scratch when its UIDVALIDITY changes", async () => {
    const box = mailbox();
    const store = new MemoryStore();
    await otherClient(box, async (client) => {
      await client.mailboxCreate("Receipts");
      await client.append("Receipts", rawMessage("old receipt 1"), []);
      await client.append("Receipts", rawMessage("old receipt 2"), []);
    });

    const connection = connect(box, store);
    await connection.start();
    expect(store.list(box.id, "Receipts")).toHaveLength(2);
    const oldValidity = (await store.getSyncPosition(box.id, "Receipts"))?.uidValidity;

    // GreenMail derives UIDVALIDITY from the clock in seconds; let it tick so the new one differs.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    // Delete and recreate the folder: same path, new UIDVALIDITY, UIDs start over.
    await otherClient(box, async (client) => {
      await client.mailboxDelete("Receipts");
      await client.mailboxCreate("Receipts");
      await client.append("Receipts", rawMessage("new receipt"), []);
    });

    const result = await connection.syncFolder("Receipts");
    expect(result.reset).toBe(true);
    const stored = store.list(box.id, "Receipts");
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]?.raw ?? []).toString()).toContain("Subject: new receipt");
    const position = await store.getSyncPosition(box.id, "Receipts");
    expect(position?.uidValidity).not.toBe(oldValidity);
  });
});

function rawMessage(subject: string): string {
  return [
    "From: someone@outside.test",
    "To: me@omni.test",
    `Subject: ${subject}`,
    `Message-ID: <${subject.replaceAll(" ", "-")}-${Date.now()}@outside.test>`,
    "",
    `body of ${subject}`,
    "",
  ].join("\r\n");
}
