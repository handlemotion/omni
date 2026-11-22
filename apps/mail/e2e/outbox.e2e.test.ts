import { forMember, schema } from "@omni/db";
import { buildCalendar, parseCalendar } from "@omni/mail-core/calendar";
import { parseMessage } from "@omni/mail-core";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type MailboxConfig, MailboxConnection } from "../src/mailbox-connection.ts";
import { deterministicMessageId, OutboxExecutor } from "../src/outbox.ts";
import { PgActionSource, PgMailStore, PgSendFiles } from "../src/pg-store.ts";
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
import { createTestBucket, links } from "./support/objects.ts";
import { deliver, logger, mailbox, otherClient, waitFor } from "./support/greenmail.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let objects: Awaited<ReturnType<typeof createTestBucket>>["objects"];
let connections: MailboxConnection[] = [];

async function setup(
  kind: "personal" | "shared" = "personal",
  edit: (box: MailboxConfig) => MailboxConfig = (box) => box,
) {
  const seeded = await seedMailbox(db, { kind });
  const box = edit(seeded.box);
  const store = new PgMailStore({ db, objects, links });
  const actions = new PgActionSource({ db });
  const connection = new MailboxConnection(box, { store, logger });
  connections.push(connection);
  const executor = new OutboxExecutor({
    actions,
    logger,
    store,
    files: new PgSendFiles({ db, objects }),
    connection: (id) => (id === box.id ? connection : undefined),
  });
  return { seeded, box, store, actions, connection, executor };
}

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

    const received = await otherClient(recipient, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await client.search({ header: { "message-id": messageId } }, { uid: true });
      } finally {
        lock.release();
      }
    });
    expect(received).toHaveLength(1);

    const sentRows = await stored(db, box.id, "Sent");
    expect(sentRows.map((r) => r.messageIdHeader)).toEqual([messageId]);
    expect(await messageRows(db, box.id)).toHaveLength(1);
  });

  it("a send with a calendar part reaches its recipient as an iMIP message their calendar can act on", async () => {
    const { seeded, box, actions, connection, executor } = await setup();
    const organizer = mailbox();
    await connection.start();
    const ics = buildCalendar(
      "REPLY",
      {
        uid: "kickoff@acme.example",
        recurrenceId: null,
        sequence: 0,
        dtstamp: new Date("2026-11-22T10:00:00Z"),
        status: "confirmed",
        busy: true,
        title: "Kickoff",
        description: null,
        location: null,
        conferenceUrl: null,
        allDay: false,
        start: new Date("2026-11-24T15:30:00Z"),
        end: new Date("2026-11-24T16:15:00Z"),
        startDay: null,
        endDay: null,
        organizer: { address: organizer.address, name: null },
        attendees: [{ address: box.address, name: null, role: "required", response: "accepted" }],
      },
      { replying: box.address },
    );
    await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-reply-${box.id}`,
      payload: {
        from: box.address,
        to: [organizer.address],
        subject: "Accepted: Kickoff",
        text: "Accepted.",
        calendar: { method: "REPLY", ics },
      },
    });
    const [claimed] = await actions.claim(1);
    if (!claimed) throw new Error("nothing claimed");
    await executor.execute(claimed);

    const raw = await waitFor(() =>
      otherClient(organizer, async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const [found] = await client.fetchAll("1:*", { source: true });
          return found?.source;
        } finally {
          lock.release();
        }
      }),
    );
    const { message, attachmentContents } = await parseMessage(raw);
    const index = message.attachments.findIndex((a) => a.mimeType === "text/calendar");
    expect(raw.toString()).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/i);
    const parsed = parseCalendar(new TextDecoder().decode(attachmentContents[index]));
    expect(parsed.ok && parsed.calendar.method).toBe("REPLY");
    expect(parsed.ok && parsed.calendar.events[0]?.attendees).toEqual([
      { address: box.address.toLowerCase(), name: null, role: "required", response: "accepted" },
    ]);
  });

  it("a new email we send stays out of the Inbox until someone replies, but is awaiting reply", async () => {
    const { seeded, box, connection, executor } = await setup();
    const recipient = mailbox();
    await connection.start();
    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-send-new-${box.id}`,
      payload: { from: box.address, to: [recipient.address], subject: "Proposal", text: "Hi" },
    });
    await executor.drain();
    expect((await actionRow(db, row.id)).status).toBe("done");
    const [sent] = await messageRows(db, box.id);
    await db
      .update(schema.threads)
      .set({ triage: "waiting_on_them", triageSource: "person" })
      .where(eq(schema.threads.id, sent!.threadId));
    const me = forMember(db, seeded.ownerId);
    const inbox = async () => (await me.listThreads({ mailboxId: box.id })).map((t) => t.id);
    const counts = async () => (await me.counts()).find((c) => c.mailboxId === box.id);

    expect(await inbox()).toEqual([]);
    expect((await me.listThreads({ mailboxId: box.id, view: "sent" })).map((t) => t.id)).toEqual([
      sent!.threadId,
    ]);
    expect(
      (await me.listThreads({ mailboxId: box.id, lane: "waiting_on_them" })).map((t) => t.id),
    ).toEqual([sent!.threadId]);
    expect(await counts()).toMatchObject({ inbox: 0, lanes: { waiting_on_them: 1 } });

    const messageId = deterministicMessageId(row.idempotencyKey, box.address);
    await deliver(box.address, "Re: Proposal", {
      from: recipient.address,
      inReplyTo: messageId,
      references: [messageId],
    });
    await waitFor(async () => (await messageRows(db, box.id)).length === 2);
    expect(await inbox()).toEqual([sent!.threadId]);
    expect(await counts()).toMatchObject({ inbox: 1 });
  });

  it("won't send in cleartext to an SMTP server that doesn't offer STARTTLS", async () => {
    const { seeded, box, connection, executor } = await setup("personal", (b) => ({
      ...b,
      smtp: { ...b.smtp, allowPlaintext: false },
    }));
    const recipient = mailbox();
    await connection.start();
    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-send-cleartext-${box.id}`,
      payload: { from: box.address, to: [recipient.address], subject: "secret", text: "hi" },
    });
    await executor.drain();

    expect(await actionRow(db, row.id)).toMatchObject({
      status: "pending",
      smtpAcceptedAt: null,
      lastError: expect.stringMatching(/STARTTLS/),
    });
    const delivered = await otherClient(recipient, async (client) => {
      const status = await client.status("INBOX", { messages: true });
      return status ? status.messages : -1;
    });
    expect(delivered).toBe(0);
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
    expect(archived[0]?.messageId).toBe(message.messageId);
  });

  it("a reply shows in its thread once SMTP accepts it, before the mailbox can file it in Sent", async () => {
    const { seeded, box, connection, executor } = await setup("shared");
    const parent = `<question.${box.id}@outside.test>`;
    await deliver(box.address, "Where is my order?", { messageId: parent });
    await connection.start();
    const [question] = await stored(db, box.id, "INBOX");
    await connection.stop();

    const reply = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-early-${box.id}`,
      payload: {
        from: box.address,
        to: ["customer@outside.test"],
        subject: "Re: Where is my order?",
        text: "On its way.",
        inReplyTo: parent,
        references: [parent],
        messageId: `<reply.${box.id}@omni.test>`,
      },
    });
    await executor.drain();
    expect((await actionRow(db, reply.id)).status).toBe("pending");
    const early = (await messageRows(db, box.id)).find((m) => m.subject.startsWith("Re:"));
    expect(early).toMatchObject({ threadId: question?.threadId, folderId: null });
    await connection.start();
    await connection.syncAll();
    expect(await messageRows(db, box.id)).toHaveLength(2);

    await db
      .update(schema.mailActions)
      .set({ runAfter: new Date() })
      .where(eq(schema.mailActions.id, reply.id));
    await executor.drain();
    expect((await actionRow(db, reply.id)).status).toBe("done");
    const [filed] = await stored(db, box.id, "Sent");
    expect(filed?.messageId).toBe(early?.id);
    expect(await messageRows(db, box.id)).toHaveLength(2);
  });

  it("archiving a conversation leaves our reply in Sent", async () => {
    const { seeded, box, store, connection, executor } = await setup("shared");
    await deliver(box.address, "Refund please");
    await connection.start();
    const [inbound] = await stored(db, box.id, "INBOX");
    await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-refund-${box.id}`,
      payload: {
        from: box.address,
        to: ["customer@outside.test"],
        subject: "Re: Refund please",
        text: "Done.",
      },
    });
    await executor.drain();
    const [sent] = await stored(db, box.id, "Sent");
    if (!inbound || !sent) throw new Error("not synced");

    for (const [folder, uid] of [
      ["INBOX", inbound.uid],
      ["Sent", sent.uid],
    ] as const) {
      const position = await store.getSyncPosition(box.id, folder);
      await enqueue(db, seeded, {
        kind: "archive",
        idempotencyKey: `idem-archive-${folder}-${box.id}`,
        payload: { folder, uidValidity: position!.uidValidity.toString(), uids: [uid] },
      });
    }
    await executor.drain();

    expect((await stored(db, box.id, "Archive")).map((r) => r.subject)).toEqual(["Refund please"]);
    expect((await stored(db, box.id, "Sent")).map((r) => r.subject)).toEqual(["Re: Refund please"]);
  });

  it("forwards with the original's attachment plus an upload, From the agent, sent once", async () => {
    const { seeded, box, connection, executor } = await setup("shared");
    const original = [
      "From: customer@outside.test",
      `To: ${box.address}`,
      "Subject: Broken invoice",
      `Message-ID: <invoice.${box.id}@outside.test>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF original invoice").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    await otherClient(box, (client) => client.append("INBOX", original, []));
    await connection.start();
    const [message] = await messageRows(db, box.id);
    const [attachment] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.messageId, message!.id));
    const uploadKey = `${seeded.orgId}/${box.id}/uploads/screenshot`;
    await objects.put(uploadKey, "PNG screenshot bytes", "image/png");
    const [upload] = await db
      .insert(schema.uploads)
      .values({
        orgId: seeded.orgId,
        mailboxId: box.id,
        filename: "screenshot.png",
        mimeType: "image/png",
        size: 20,
        r2Key: uploadKey,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();

    const recipient = mailbox();
    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-forward-${box.id}`,
      payload: {
        from: box.address,
        fromName: "Ana from Acme",
        to: [recipient.address],
        subject: "Fwd: Broken invoice",
        text: "Billing, can you look at this?",
        inReplyToMessageId: message!.id,
        attachments: [
          { kind: "attachment", attachmentId: attachment!.id },
          { kind: "upload", uploadId: upload!.id },
        ],
        messageId: `<forward.${box.id}@omni.test>`,
      },
    });
    const [claimed] = await new PgActionSource({ db }).claim(1);
    await executor.execute(claimed!);
    await executor.execute(await asClaimed(db, row.id));
    expect((await actionRow(db, row.id)).status).toBe("done");

    const received = await otherClient(recipient, async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await client.fetchAll("1:*", { source: true });
      } finally {
        lock.release();
      }
    });
    expect(received).toHaveLength(1);
    const raw = received[0]?.source?.toString() ?? "";
    expect(raw).toContain(`From: Ana from Acme <${box.address}>`);
    expect(raw).toContain("Content-Type: application/pdf; name=invoice.pdf");
    expect(raw).toContain(Buffer.from("%PDF original invoice").toString("base64"));
    expect(raw).toContain("Content-Type: image/png; name=screenshot.png");
    expect(raw).toContain(Buffer.from("PNG screenshot bytes").toString("base64"));
    const forward = (await messageRows(db, box.id)).find((m) => m.subject.startsWith("Fwd:"));
    expect(forward?.threadId).toBe(message!.threadId);
  });

  it("fails a send whose upload is gone without sending anything", async () => {
    const { seeded, box, connection, executor } = await setup();
    await connection.start();
    const recipient = mailbox();
    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-missing-${box.id}`,
      payload: {
        from: box.address,
        to: [recipient.address],
        subject: "with a lost file",
        text: "see attached",
        attachments: [{ kind: "upload", uploadId: "upload-that-never-existed" }],
      },
    });
    await executor.drain();

    expect(await actionRow(db, row.id)).toMatchObject({ status: "failed", smtpAcceptedAt: null });
    const delivered = await otherClient(recipient, async (client) => {
      const status = await client.status("INBOX", { messages: true });
      return status ? status.messages : -1;
    });
    expect(delivered).toBe(0);
  });

  it("spam moves a conversation to Junk and out of the inbox; not spam and trash follow", async () => {
    const { seeded, box, store, connection, executor } = await setup("shared");
    await deliver(box.address, "Win a prize");
    await connection.start();
    const thread = async () => {
      const [row] = await messageRows(db, box.id);
      const [t] = await db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, row!.threadId));
      return t!;
    };
    const run = async (kind: "spam" | "not_spam" | "trash", folder: string) => {
      const [copy] = await stored(db, box.id, folder);
      const position = await store.getSyncPosition(box.id, folder);
      const row = await enqueue(db, seeded, {
        kind,
        idempotencyKey: `idem-${kind}-${box.id}`,
        payload: { folder, uidValidity: position!.uidValidity.toString(), uids: [copy!.uid] },
      });
      await executor.drain();
      expect((await actionRow(db, row.id)).status).toBe("done");
    };

    await run("spam", "INBOX");
    expect(await stored(db, box.id, "INBOX")).toHaveLength(0);
    expect((await stored(db, box.id, "Junk")).map((r) => r.subject)).toEqual(["Win a prize"]);
    const [junk] = await db
      .select({ role: schema.mailboxFolders.role })
      .from(schema.mailboxFolders)
      .where(eq(schema.mailboxFolders.path, "Junk"));
    expect(junk?.role).toBe("junk");
    expect((await thread()).archived).toBe(true);

    await run("not_spam", "Junk");
    expect((await stored(db, box.id, "INBOX")).map((r) => r.subject)).toEqual(["Win a prize"]);
    expect((await thread()).archived).toBe(false);

    await run("trash", "INBOX");
    expect((await stored(db, box.id, "Trash")).map((r) => r.subject)).toEqual(["Win a prize"]);
    expect((await thread()).archived).toBe(true);
    expect(await messageRows(db, box.id)).toHaveLength(1);
  });

  it("a send SMTP already accepted is done, not failed, when its upload is gone by the retry", async () => {
    const { seeded, box, actions, connection, executor } = await setup();
    await connection.start();
    const recipient = mailbox();
    const row = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `idem-accepted-missing-${box.id}`,
      payload: {
        from: box.address,
        to: [recipient.address],
        subject: "delivered, then its file was deleted",
        text: "see attached",
        attachments: [{ kind: "upload", uploadId: "upload-deleted-after-send" }],
      },
    });
    await actions.claim(1);
    await actions.markSmtpAccepted(row.id);
    await executor.execute(await asClaimed(db, row.id));

    expect((await actionRow(db, row.id)).status).toBe("done");
    const resent = await otherClient(recipient, async (client) => {
      const status = await client.status("INBOX", { messages: true });
      return status ? status.messages : -1;
    });
    expect(resent).toBe(0);
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
