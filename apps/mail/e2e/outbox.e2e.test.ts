import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxConnection } from "../src/mailbox-connection.ts";
import { deterministicMessageId, OutboxExecutor } from "../src/outbox.ts";
import { deliver, logger, mailbox, otherClient, purge, waitFor } from "./support/greenmail.ts";
import { MemoryActions, MemoryStore } from "./support/memory-store.ts";

let connections: MailboxConnection[] = [];

async function setup(kind: "personal" | "shared" = "personal") {
  const box = mailbox(kind);
  const store = new MemoryStore();
  const actions = new MemoryActions();
  const connection = new MailboxConnection(box, { store, logger });
  connections.push(connection);
  const executor = new OutboxExecutor({
    actions,
    logger,
    connection: (id) => (id === box.id ? connection : undefined),
  });
  return { box, store, actions, connection, executor };
}

beforeEach(async () => {
  await purge();
});

afterEach(async () => {
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

describe("OutboxExecutor against GreenMail", () => {
  it("sends once and files exactly one copy in Sent, even when executed twice", async () => {
    const { box, store, actions, connection, executor } = await setup();
    const recipient = mailbox();
    await connection.start();

    actions.enqueue({
      id: "send-1",
      mailboxId: box.id,
      kind: "send",
      idempotencyKey: "idem-send-1",
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
    // The process died after the work but before `complete` was saved: the row is claimed again.
    await executor.execute(actions.current("send-1"));

    expect(actions.row("send-1")).toMatchObject({ status: "done", errors: [] });
    const messageId = deterministicMessageId("idem-send-1", box.address);

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

    // The Sent copy is in the store right away, without waiting for the periodic sync.
    expect(store.list(box.id, "Sent")).toHaveLength(1);
  });

  it("finishes the Sent append without resending when SMTP already accepted", async () => {
    const { box, actions, connection, executor } = await setup();
    const recipient = mailbox();
    await connection.start();

    actions.enqueue({
      id: "send-2",
      mailboxId: box.id,
      kind: "send",
      idempotencyKey: "idem-send-2",
      payload: { from: box.address, to: [recipient.address], subject: "once", text: "hi" },
    });
    // An earlier attempt got SMTP's OK, then crashed before the IMAP append.
    await actions.claim(1);
    await actions.markSmtpAccepted("send-2");
    await executor.execute(actions.current("send-2"));

    expect(actions.row("send-2").status).toBe("done");
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
    const { box, store, actions, connection, executor } = await setup();
    await deliver(box.address, "to archive");
    await connection.start();
    const [message] = store.list(box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    actions.enqueue({
      id: "archive-1",
      mailboxId: box.id,
      kind: "archive",
      idempotencyKey: "idem-archive-1",
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();

    expect(actions.row("archive-1").status).toBe("done");
    expect(store.list(box.id, "INBOX")).toHaveLength(0);
    const archived = store.list(box.id, "Archive");
    expect(archived).toHaveLength(1);
    expect(Buffer.from(archived[0]?.raw ?? []).toString()).toContain("Subject: to archive");
  });

  it("refuses to touch UIDs whose folder UIDVALIDITY changed", async () => {
    const { box, store, actions, connection, executor } = await setup();
    await deliver(box.address, "stale target");
    await connection.start();
    const [message] = store.list(box.id, "INBOX");

    actions.enqueue({
      id: "move-stale",
      mailboxId: box.id,
      kind: "move",
      idempotencyKey: "idem-move-stale",
      payload: {
        folder: "INBOX",
        uidValidity: "1",
        uids: [message?.uid ?? 1],
        destination: "Trash",
      },
    });
    await executor.drain();

    expect(actions.row("move-stale").status).toBe("failed");
    expect(store.list(box.id, "INBOX")).toHaveLength(1);
  });

  it("never changes \\Seen on a shared mailbox", async () => {
    const { box, store, actions, connection, executor } = await setup("shared");
    await deliver(box.address, "team mail");
    await connection.start();
    const [message] = store.list(box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    actions.enqueue({
      id: "read-shared",
      mailboxId: box.id,
      kind: "mark_read",
      idempotencyKey: "idem-read-shared",
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();
    expect(actions.row("read-shared").status).toBe("done");

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
    const { box, store, actions, connection, executor } = await setup();
    await deliver(box.address, "personal mail");
    await connection.start();
    const [message] = store.list(box.id, "INBOX");
    const position = await store.getSyncPosition(box.id, "INBOX");
    if (!message || !position) throw new Error("not synced");

    actions.enqueue({
      id: "read-personal",
      mailboxId: box.id,
      kind: "mark_read",
      idempotencyKey: "idem-read-personal",
      payload: {
        folder: "INBOX",
        uidValidity: position.uidValidity.toString(),
        uids: [message.uid],
      },
    });
    await executor.drain();

    expect(actions.row("read-personal").status).toBe("done");
    await waitFor(() => store.list(box.id, "INBOX")[0]?.flags.includes("\\Seen"));
  });
});
