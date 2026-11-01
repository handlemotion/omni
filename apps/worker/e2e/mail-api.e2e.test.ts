import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
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
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function api(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, worker.url), {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
}

async function get<T>(path: string, cookie: string) {
  return (await (await api(path, cookie)).json()) as T;
}

type Ids = { id: string }[];

describe("member isolation", () => {
  test("a member cannot read or act on a mailbox they were not granted", async () => {
    const { db } = database;
    const org = await createOrg(db, "acme");
    const other = await createOrg(db, "globex");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@acme.test");
    await createMember(db, org.id, "bea@acme.test");

    const anaBox = await createMailbox(db, org.id, "ana@acme.test", "personal");
    await grant(db, org.id, anaBox.id, ana.id);
    // Same org, not granted to Ana.
    const beaBox = await createMailbox(db, org.id, "bea@acme.test", "personal");
    // Another org entirely.
    const globexBox = await createMailbox(db, other.id, "hello@globex.test");

    const mine = await seedMessage(db, anaBox, {
      subject: "Quarterly plan",
      fromAddress: "luis@client.test",
      uid: 1,
    });
    const colleague = await seedMessage(db, beaBox, {
      subject: "Salary review",
      fromAddress: "hr@acme.test",
      uid: 1,
    });
    const foreign = await seedMessage(db, globexBox, {
      subject: "Salary benchmark",
      fromAddress: "ceo@globex.test",
      uid: 1,
    });

    const cookie = await signIn(worker, db, "ana@acme.test");

    const mailboxes = await get<{ mailboxes: Ids }>("/mailboxes", cookie);
    expect(mailboxes.mailboxes.map((m) => m.id)).toEqual([anaBox.id]);

    const listed = await get<{ threads: Ids }>("/threads", cookie);
    expect(listed.threads.map((t) => t.id)).toEqual([mine.threadId]);
    const filtered = await get<{ threads: Ids }>(`/threads?mailboxId=${beaBox.id}`, cookie);
    expect(filtered.threads).toEqual([]);

    for (const threadId of [colleague.threadId, foreign.threadId]) {
      expect((await api(`/threads/${threadId}`, cookie)).status).toBe(404);
      const archive = await api(`/threads/${threadId}/archive`, cookie, {
        method: "POST",
        headers: { "idempotency-key": `archive-${threadId}` },
      });
      expect(archive.status).toBe(404);
      const reply = await api(`/threads/${threadId}/reply`, cookie, {
        method: "POST",
        headers: { "idempotency-key": `reply-${threadId}` },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(reply.status).toBe(404);
      const state = await api(`/threads/${threadId}/state`, cookie, {
        method: "PATCH",
        headers: { "idempotency-key": `state-${threadId}` },
        body: JSON.stringify({ read: true }),
      });
      expect(state.status).toBe(404);
    }

    const search = await get<{ results: unknown[] }>("/search?q=salary", cookie);
    expect(search.results).toEqual([]);

    const send = await api("/send", cookie, {
      method: "POST",
      headers: { "idempotency-key": "send-from-bea" },
      body: JSON.stringify({ mailboxId: beaBox.id, to: ["x@y.test"], subject: "s", text: "t" }),
    });
    expect(send.status).toBe(404);

    // Nothing reached the outbox for mailboxes Ana cannot see, and nobody else's state changed.
    const leaked = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.memberId, ana.id));
    expect(leaked).toEqual([]);
    const archived = await db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(eq(schema.threads.archived, true));
    expect(archived).toEqual([]);
  });
});

describe("outbox", () => {
  test("a repeated archive enqueues once and the ping carries a valid signature", async () => {
    const { db } = database;
    const org = await createOrg(db, "initech");
    const member = await createMember(db, org.id, "ana@initech.test");
    const box = await createMailbox(db, org.id, "ana@initech.test", "personal");
    await grant(db, org.id, box.id, member.id);
    const { threadId } = await seedMessage(db, box, {
      subject: "Invoice",
      fromAddress: "billing@vendor.test",
      uid: 42,
    });
    const cookie = await signIn(worker, db, "ana@initech.test");
    const pingsBefore = mailService.requests.length;

    const archive = async () => {
      const response = await api(`/threads/${threadId}/archive`, cookie, {
        method: "POST",
        headers: { "idempotency-key": "archive-invoice-1" },
      });
      return (await response.json()) as { actionIds: string[] };
    };
    const first = await archive();
    const second = await archive();
    expect(first.actionIds).toHaveLength(1);
    expect(second.actionIds).toEqual(first.actionIds);

    const rows = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.memberId, member.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "archive",
      mailboxId: box.id,
      payload: { folder: "INBOX", uidValidity: "1700000000", uids: [42] },
    });
    const [thread] = await db
      .select({ archived: schema.threads.archived })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread?.archived).toBe(true);

    const pings = (await mailService.waitFor(pingsBefore + 1)).slice(pingsBefore);
    expect(pings.every((p) => p.path === "/ping" && p.verified.ok)).toBe(true);
  });

  test("a reply threads onto the latest message", async () => {
    const { db } = database;
    const org = await createOrg(db, "hooli");
    const member = await createMember(db, org.id, "ana@hooli.test");
    const box = await createMailbox(db, org.id, "hello@hooli.test");
    await grant(db, org.id, box.id, member.id);
    const first = await seedMessage(db, box, {
      subject: "Partnership",
      fromAddress: "luis@client.test",
      to: ["hello@hooli.test"],
      uid: 1,
      messageId: "<first@client.test>",
      sentAt: new Date("2026-10-01T10:00:00Z"),
    });
    await seedMessage(db, box, {
      subject: "Re: Partnership",
      fromAddress: "luis@client.test",
      to: ["hello@hooli.test", "marta@client.test"],
      uid: 2,
      messageId: "<second@client.test>",
      threadId: first.threadId,
      sentAt: new Date("2026-10-02T10:00:00Z"),
    });
    await db
      .update(schema.messages)
      .set({ references: ["<first@client.test>"], inReplyTo: "<first@client.test>" })
      .where(eq(schema.messages.messageIdHeader, "<second@client.test>"));
    const cookie = await signIn(worker, db, "ana@hooli.test");

    const reply = await api(`/threads/${first.threadId}/reply`, cookie, {
      method: "POST",
      headers: { "idempotency-key": "reply-partnership-1" },
      body: JSON.stringify({ text: "Sounds good.", replyAll: true }),
    });
    expect(reply.status).toBe(202);
    const { actionId } = (await reply.json()) as { actionId: string };
    const [action] = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.id, actionId));
    expect(action?.payload).toEqual({
      from: "hello@hooli.test",
      to: ["luis@client.test"],
      cc: ["marta@client.test"],
      subject: "Re: Partnership",
      text: "Sounds good.",
      inReplyTo: "<second@client.test>",
      references: ["<first@client.test>", "<second@client.test>"],
    });
  });
});
