// CRM forwarding address (ADR 0032) against GreenMail: what reaches the CRM, from whom, and once.
import { schema } from "@omni/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PgForwarding } from "../src/forward-copy.ts";
import { MailboxConnection, type MailboxConfig } from "../src/mailbox-connection.ts";
import { OutboxExecutor } from "../src/outbox.ts";
import { PgActionSource, PgMailStore } from "../src/pg-store.ts";
import {
  actionRow,
  asClaimed,
  createTestDatabase,
  enqueue,
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

async function setup(scope: "conversations" | "all", options: { since?: Date } = {}) {
  const seeded = await seedMailbox(db);
  const crm = mailbox();
  await db
    .update(schema.mailboxes)
    .set({
      forwardAddress: crm.address,
      forwardScope: scope,
      forwardSince: options.since ?? new Date(),
    })
    .where(eq(schema.mailboxes.id, seeded.box.id));
  const store = new PgMailStore({ db, objects, links });
  const actions = new PgActionSource({ db });
  const connection = new MailboxConnection(seeded.box, { store, logger });
  connections.push(connection);
  const executor = new OutboxExecutor({
    actions,
    logger,
    store,
    forwarding: new PgForwarding({ db, objects }),
    connection: (id) => (id === seeded.box.id ? connection : undefined),
  });
  return { seeded, box: seeded.box, crm, connection, executor };
}

function forwardCopies(mailboxId: string) {
  return db
    .select()
    .from(schema.mailActions)
    .where(
      and(eq(schema.mailActions.mailboxId, mailboxId), eq(schema.mailActions.kind, "forward_copy")),
    )
    .orderBy(asc(schema.mailActions.createdAt));
}

/** Claims one action, as `PgActionSource.claim` would, so the executor can complete it. */
async function claim(id: string) {
  await db
    .update(schema.mailActions)
    .set({
      status: "running",
      lockedAt: new Date(),
      attempts: sql`${schema.mailActions.attempts} + 1`,
    })
    .where(eq(schema.mailActions.id, id));
  return asClaimed(db, id);
}

/** Every message in a GreenMail inbox, raw. */
function inbox(box: MailboxConfig) {
  return otherClient(box, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const all = await client.fetchAll("1:*", { source: true }).catch(() => []);
      return all.map((m) => m.source?.toString() ?? "");
    } finally {
      lock.release();
    }
  });
}

describe("CRM forwarding address", () => {
  it("BCCs your replies and forwards each received message of the conversation once, from you", async () => {
    const { seeded, box, crm, connection, executor } = await setup("conversations");
    await connection.start();

    await deliver(box.address, "Quote request", { messageId: "<quote@outside.test>" });
    await deliver(box.address, "Weekly newsletter");
    const [quote] = await waitFor(async () => {
      const rows = await stored(db, box.id, "INBOX");
      return rows.length === 2 && rows;
    });
    // Nobody has written back yet: nothing is the CRM's business.
    expect(await forwardCopies(box.id)).toHaveLength(0);

    const reply = await enqueue(db, seeded, {
      kind: "send",
      idempotencyKey: `forwarding-reply-${box.id}`,
      payload: {
        from: box.address,
        to: ["sender@outside.test"],
        subject: "Re: Quote request",
        text: "Here is our quote.",
        inReplyTo: "<quote@outside.test>",
        references: ["<quote@outside.test>"],
        inReplyToMessageId: quote!.messageId,
      },
    });
    await executor.execute(await claim(reply.id));
    expect(await actionRow(db, reply.id)).toMatchObject({ status: "done" });

    // The reply queued the message it answers; the newsletter stays out.
    const afterReply = await forwardCopies(box.id);
    expect(afterReply.map((a) => a.payload)).toEqual([{ messageId: quote!.messageId }]);

    const sentId = (
      await db
        .select({ header: schema.messages.messageIdHeader })
        .from(schema.messages)
        .where(eq(schema.messages.subject, "Re: Quote request"))
    )[0]!.header;
    await deliver(box.address, "Re: Quote request", {
      messageId: "<accepted@outside.test>",
      inReplyTo: sentId,
      references: ["<quote@outside.test>", sentId],
    });
    await waitFor(async () => (await forwardCopies(box.id)).length === 2);

    for (const action of await forwardCopies(box.id)) {
      await executor.execute(await claim(action.id));
      // The worker died before `complete` landed: the copy runs again and sends nothing.
      await executor.execute(await asClaimed(db, action.id));
      expect(await actionRow(db, action.id)).toMatchObject({ status: "done" });
    }

    const received = await waitFor(async () => {
      const all = await inbox(crm);
      return all.length >= 3 && all;
    });
    // Settle: a duplicate would land within GreenMail's delivery time.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inbox(crm)).toHaveLength(3);

    const ours = received.find((raw) => raw.includes("Here is our quote."));
    expect(ours).toContain(`From: ${box.address}`);
    const copies = received.filter((raw) => raw.includes("Subject: Fwd: "));
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy).toContain(`From: ${box.address}`);
      expect(copy).toContain(`To: ${crm.address}`);
      expect(copy).toContain("---------- Forwarded message ---------");
      expect(copy).toContain("From: sender@outside.test");
    }
    expect(copies.join("\n")).toContain("body of Quote request");
    expect(copies.join("\n")).not.toContain("Weekly newsletter");

    // The person you wrote to never learns the CRM's address.
    const theirs = await waitFor(async () => {
      const all = await inbox({
        ...box,
        address: "sender@outside.test",
        user: "sender@outside.test",
      });
      return all.find((raw) => raw.includes("Here is our quote."));
    });
    expect(theirs).not.toContain(crm.address);
  });

  it("forwards new inbox mail under `all`, never mail older than when it was turned on", async () => {
    const { box, crm, connection, executor } = await setup("all");
    await deliver(box.address, "From last year", { date: new Date(Date.now() - 365 * 86_400_000) });
    await connection.start();
    await waitFor(async () => (await stored(db, box.id, "INBOX")).length === 1);
    await deliver(box.address, "Fresh lead");
    await waitFor(async () => (await stored(db, box.id, "INBOX")).length === 2);

    const queued = await forwardCopies(box.id);
    expect(queued).toHaveLength(1);
    await executor.execute(await claim(queued[0]!.id));

    const received = await waitFor(async () => {
      const all = await inbox(crm);
      return all.length === 1 && all;
    });
    expect(received[0]).toContain("Subject: Fwd: Fresh lead");
  });

  it("drops a queued copy once forwarding is turned off", async () => {
    const { box, crm, connection, executor } = await setup("all");
    await connection.start();
    await deliver(box.address, "Before turning it off");
    await waitFor(async () => (await forwardCopies(box.id)).length === 1);
    await db
      .update(schema.mailboxes)
      .set({ forwardAddress: null, forwardSince: null })
      .where(eq(schema.mailboxes.id, box.id));

    const [queued] = await forwardCopies(box.id);
    await executor.execute(await claim(queued!.id));
    expect(await actionRow(db, queued!.id)).toMatchObject({ status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inbox(crm)).toHaveLength(0);
  });
});
