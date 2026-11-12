// Customers over the real Worker and Postgres: filled from the mail service's events, linked to
// their conversations, and visible only through conversations a member can see.
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  postMailEvents,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function api(path: string, cookie: string) {
  return fetch(new URL(`/api${path}`, worker.url), { headers: { cookie } });
}

/** A message the mail service indexed, announced to the Worker the way it does. */
async function deliver(
  mailbox: { id: string; orgId: string },
  message: Parameters<typeof seedMessage>[2],
) {
  const seeded = await seedMessage(database.db, mailbox, message);
  const event = {
    type: "message.created" as const,
    orgId: mailbox.orgId,
    mailboxId: mailbox.id,
    threadId: seeded.threadId,
    messageId: seeded.messageId,
    folderRole: "inbox" as const,
  };
  const response = await postMailEvents(worker, { events: [event] });
  expect(response.status).toBe(202);
  return { ...seeded, event };
}

async function threadCustomer(threadId: string) {
  const [row] = await database.db
    .select({ customerId: schema.threads.customerId })
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return row!.customerId;
}

describe("customers", () => {
  test("ingest records the sender once per org, links the conversation, and skips the inbox's own mail", async () => {
    const { db } = database;
    const org = await createOrg(db, "ingest");
    const support = await createMailbox(db, org.id, "support@ingest.test");
    const billing = await createMailbox(db, org.id, "billing@ingest.test");

    const first = await deliver(support, {
      subject: "Refund",
      fromAddress: "Luis@Client.test",
      fromName: "Luis",
      uid: 1,
      sentAt: new Date("2026-11-01T10:00:00Z"),
    });
    // The same person writes to another inbox later, with a fuller name.
    const second = await deliver(billing, {
      subject: "Invoice",
      fromAddress: "luis@client.test",
      fromName: "Luis Pérez",
      uid: 1,
      sentAt: new Date("2026-11-05T10:00:00Z"),
    });
    // Redelivered (at least once): nothing changes.
    expect((await postMailEvents(worker, { events: [first.event] })).status).toBe(202);
    // The inbox's own reply in the thread is not a customer.
    await deliver(support, {
      subject: "Re: Refund",
      fromAddress: "support@ingest.test",
      uid: 2,
      threadId: first.threadId,
    });

    const rows = await db.select().from(schema.customers).where(eq(schema.customers.orgId, org.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      address: "luis@client.test",
      name: "Luis Pérez",
      domain: "client.test",
      company: "Client",
      firstSeenAt: new Date("2026-11-01T10:00:00Z"),
      lastSeenAt: new Date("2026-11-05T10:00:00Z"),
    });
    expect(await threadCustomer(first.threadId)).toBe(rows[0]!.id);
    expect(await threadCustomer(second.threadId)).toBe(rows[0]!.id);

    // A webmail address is a person, not a company.
    await deliver(support, { subject: "Hi", fromAddress: "maria@gmail.com", uid: 3 });
    const [maria] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.address, "maria@gmail.com"));
    expect(maria).toMatchObject({ domain: null, company: null });

    // Indexed out of order: a later message without a name, then an older one with a new name.
    // The name follows the newest message that had one, not the newest message.
    await deliver(support, {
      subject: "Again",
      fromAddress: "ana@shop.test",
      fromName: "Ana",
      uid: 4,
      sentAt: new Date("2026-11-01T10:00:00Z"),
    });
    await deliver(support, {
      subject: "Again 2",
      fromAddress: "ana@shop.test",
      uid: 5,
      sentAt: new Date("2026-11-05T10:00:00Z"),
    });
    await deliver(support, {
      subject: "Again 3",
      fromAddress: "ana@shop.test",
      fromName: "Ana Ruiz",
      uid: 6,
      sentAt: new Date("2026-11-03T10:00:00Z"),
    });
    const [ana] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.address, "ana@shop.test"));
    expect(ana).toMatchObject({ name: "Ana Ruiz", lastSeenAt: new Date("2026-11-05T10:00:00Z") });
  });

  test("profile, history and autocomplete show only conversations the member can see", async () => {
    const { db } = database;
    const org = await createOrg(db, "visible");
    const support = await createMailbox(db, org.id, "support@visible.test");
    const hr = await createMailbox(db, org.id, "hr@visible.test");
    const ana = await createMember(db, org.id, "ana@visible.test");
    await grant(db, org.id, support.id, ana.id);
    const cookie = await signIn(worker, db, "ana@visible.test");

    const refund = await deliver(support, {
      subject: "Refund please",
      fromAddress: "luis@client.test",
      fromName: "Luis Pérez",
      uid: 1,
    });
    await deliver(hr, { subject: "My salary", fromAddress: "luis@client.test", uid: 1 });
    // Someone who only ever wrote to hr@, which Ana is not on.
    await deliver(hr, { subject: "Complaint", fromAddress: "lucia@other.test", uid: 2 });
    const customerId = (await threadCustomer(refund.threadId))!;

    const search = async (q: string) =>
      (
        (await (await api(`/customers?q=${encodeURIComponent(q)}`, cookie)).json()) as {
          customers: { address: string }[];
        }
      ).customers.map((c) => c.address);
    expect(await search("lu")).toEqual(["luis@client.test"]);
    expect(await search("pér")).toEqual(["luis@client.test"]);
    expect(await search("lucia")).toEqual([]);
    // LIKE wildcards are literal.
    expect(await search("%")).toEqual([]);

    const profile = (await (await api(`/customers/${customerId}`, cookie)).json()) as {
      name: string;
      conversations: { id: string; subject: string; mailboxAddress: string }[];
    };
    expect(profile.name).toBe("Luis Pérez");
    expect(profile.conversations).toEqual([
      expect.objectContaining({
        id: refund.threadId,
        subject: "Refund please",
        mailboxAddress: "support@visible.test",
      }),
    ]);

    const [lucia] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.address, "lucia@other.test"));
    expect((await api(`/customers/${lucia!.id}`, cookie)).status).toBe(404);
  });
});
