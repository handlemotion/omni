import { addLocation, schema, upsertFolder } from "@omni/db";
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
  test("a repeated archive enqueues once per folder copy and the ping carries a valid signature", async () => {
    const { db } = database;
    const org = await createOrg(db, "initech");
    const member = await createMember(db, org.id, "ana@initech.test");
    const box = await createMailbox(db, org.id, "ana@initech.test", "personal");
    await grant(db, org.id, box.id, member.id);
    const { threadId, messageId } = await seedMessage(db, box, {
      subject: "Invoice",
      fromAddress: "billing@vendor.test",
      uid: 42,
    });
    // The same message also sits in another folder (copied there in Apple Mail).
    const projects = await upsertFolder(db, {
      orgId: org.id,
      mailboxId: box.id,
      path: "Projects",
      role: "other",
      uidvalidity: 1_700_000_500,
      uidnext: 10,
      highestModseq: null,
    });
    await addLocation(db, {
      orgId: org.id,
      mailboxId: box.id,
      folderId: projects.id,
      uid: 7,
      messageId,
      flags: [],
      modseq: null,
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
    expect(first.actionIds).toHaveLength(2);
    expect(second.actionIds).toEqual(first.actionIds);

    const rows = await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.memberId, member.id))
      .orderBy(schema.mailActions.createdAt);
    expect(rows.map(({ kind, mailboxId, payload }) => ({ kind, mailboxId, payload }))).toEqual([
      {
        kind: "archive",
        mailboxId: box.id,
        payload: { folder: "INBOX", uidValidity: "1700000000", uids: [42] },
      },
      {
        kind: "archive",
        mailboxId: box.id,
        payload: { folder: "Projects", uidValidity: "1700000500", uids: [7] },
      },
    ]);
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

describe("reads for the apps", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n, 10));
  type Row = {
    id: string;
    subject: string;
    snippet: string;
    latestFrom: { name: string | null; address: string };
    participants: { name: string | null; address: string }[];
    messageCount: number;
    hasAttachments: boolean;
    read: boolean;
    snoozedUntil: string | null;
  };
  const ids = async (path: string, cookie: string) =>
    (await get<{ threads: Row[] }>(path, cookie)).threads.map((t) => t.id);
  let patches = 0;
  const setState = (threadId: string, cookie: string, body: object) =>
    api(`/threads/${threadId}/state`, cookie, {
      method: "PATCH",
      headers: { "idempotency-key": `state-${threadId}-${patches++}` },
      body: JSON.stringify(body),
    });

  test("list rows carry what a row shows, and snoozes move threads between views for their member only", async () => {
    const { db } = database;
    const org = await createOrg(db, "umbrella");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@umbrella.test");
    const bea = await createMember(db, org.id, "bea@umbrella.test");
    const box = await createMailbox(db, org.id, "hello@umbrella.test");
    await grant(db, org.id, box.id, ana.id);
    await grant(db, org.id, box.id, bea.id);

    // Three senders, one twice in another case, and our own reply last.
    const proposal = await seedMessage(db, box, {
      subject: "Proposal",
      fromAddress: "luis@client.test",
      uid: 1,
      sentAt: day(1),
    });
    for (const [uid, fromAddress, sentAt] of [
      [2, "marta@client.test", day(2)],
      [3, "LUIS@client.test", day(3)],
    ] as const) {
      await seedMessage(db, box, {
        subject: "Re: Proposal",
        fromAddress,
        uid,
        threadId: proposal.threadId,
        sentAt,
      });
    }
    const ours = await seedMessage(db, box, {
      subject: "Re: Proposal (v2)",
      fromAddress: "hello@umbrella.test",
      folder: "Sent",
      uid: 1,
      threadId: proposal.threadId,
      sentAt: day(4),
      text: `  Here is   the\n\nrevised\tproposal. ${"More detail. ".repeat(30)}`,
    });
    await db
      .update(schema.messages)
      .set({ fromName: "Hello Team" })
      .where(eq(schema.messages.id, ours.messageId));
    await db.insert(schema.attachments).values({
      orgId: org.id,
      messageId: proposal.messageId,
      filename: "terms.pdf",
      mimeType: "application/pdf",
      size: 10,
      r2Key: `${org.id}/${box.id}/att/${"a".repeat(64)}`,
    });
    const newer = await seedMessage(db, box, {
      subject: "Lunch?",
      fromAddress: "pat@client.test",
      uid: 4,
      sentAt: day(5),
    });
    const archived = await seedMessage(db, box, {
      subject: "Old news",
      fromAddress: "pat@client.test",
      uid: 5,
      sentAt: day(6),
    });
    await db
      .update(schema.threads)
      .set({ archived: true })
      .where(eq(schema.threads.id, archived.threadId));
    await db
      .update(schema.threads)
      .set({ triage: "needs_reply", triageSource: "person" })
      .where(eq(schema.threads.id, proposal.threadId));

    const anaCookie = await signIn(worker, db, "ana@umbrella.test");
    const beaCookie = await signIn(worker, db, "bea@umbrella.test");

    const { threads } = await get<{ threads: Row[] }>("/threads", anaCookie);
    expect(threads.map((t) => t.id)).toEqual([newer.threadId, proposal.threadId]);
    // Catches rows built from the first message instead of the latest, senders repeated per
    // message or per address case, and snippets that keep the body's raw whitespace.
    expect(threads[1]).toMatchObject({
      subject: "Re: Proposal (v2)",
      latestFrom: { name: "Hello Team", address: "hello@umbrella.test" },
      participants: [
        { name: "Hello Team", address: "hello@umbrella.test" },
        { name: null, address: "LUIS@client.test" },
        { name: null, address: "marta@client.test" },
      ],
      messageCount: 4,
      hasAttachments: true,
      read: false,
      snoozedUntil: null,
    });
    expect(threads[1]!.snippet).toMatch(/^Here is the revised proposal\. More detail\./);
    expect(threads[1]!.snippet).toHaveLength(160);
    expect(threads[0]).toMatchObject({ messageCount: 1, hasAttachments: false });

    // Ana snoozes the proposal into the future, and the newer thread into the past.
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect((await setState(proposal.threadId, anaCookie, { snoozedUntil: until })).status).toBe(
      200,
    );
    const past = { snoozedUntil: day(1).toISOString() };
    expect((await setState(newer.threadId, anaCookie, past)).status).toBe(200);

    expect(await ids("/threads?view=inbox", anaCookie)).toEqual([newer.threadId]);
    expect(await ids("/threads?view=snoozed", anaCookie)).toEqual([proposal.threadId]);
    expect(await ids("/threads?view=archive", anaCookie)).toEqual([archived.threadId]);
    // Lanes filter every view.
    expect(await ids("/threads?view=snoozed&lane=needs_reply", anaCookie)).toEqual([
      proposal.threadId,
    ]);
    expect(await ids("/threads?view=snoozed&lane=fyi", anaCookie)).toEqual([]);
    expect(await ids("/threads?lane=needs_reply", anaCookie)).toEqual([]);

    // Ana's snooze is hers: Bea still has the proposal in her inbox and nothing snoozed.
    expect(await ids("/threads", beaCookie)).toEqual([newer.threadId, proposal.threadId]);
    expect(await ids("/threads?view=snoozed", beaCookie)).toEqual([]);
    expect(await ids("/threads?lane=needs_reply", beaCookie)).toEqual([proposal.threadId]);

    // Unsnoozed, it is back in Ana's inbox.
    await setState(proposal.threadId, anaCookie, { snoozedUntil: null });
    expect(await ids("/threads", anaCookie)).toEqual([newer.threadId, proposal.threadId]);
  });

  test("counts are unread inbox threads per granted mailbox and lane, per member", async () => {
    const { db } = database;
    const org = await createOrg(db, "tyrell");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@tyrell.test");
    const bea = await createMember(db, org.id, "bea@tyrell.test");
    const sales = await createMailbox(db, org.id, "sales@tyrell.test");
    const support = await createMailbox(db, org.id, "support@tyrell.test");
    const hr = await createMailbox(db, org.id, "hr@tyrell.test");
    for (const box of [sales, support]) await grant(db, org.id, box.id, ana.id);
    await grant(db, org.id, sales.id, bea.id);
    await seedMessage(db, hr, { subject: "Not Ana's", fromAddress: "x@y.test", uid: 1 });

    const seed = async (uid: number, triage?: { bucket: "needs_reply" | "fyi"; c: number }) => {
      const { threadId } = await seedMessage(db, sales, {
        subject: `Lead ${uid}`,
        fromAddress: "lead@client.test",
        uid,
      });
      if (triage) {
        await db
          .update(schema.threads)
          .set({ triage: triage.bucket, triageConfidence: triage.c, triageSource: "ai" })
          .where(eq(schema.threads.id, threadId));
      }
      return threadId;
    };
    const sure = await seed(1, { bucket: "needs_reply", c: 0.95 });
    await seed(2, { bucket: "needs_reply", c: 0.95 });
    await seed(3, { bucket: "fyi", c: 0.4 });
    const read = await seed(4, { bucket: "needs_reply", c: 0.95 });
    const snoozed = await seed(5, { bucket: "fyi", c: 0.99 });
    const archived = await seed(6, { bucket: "needs_reply", c: 0.95 });
    await seed(7);
    await db.update(schema.threads).set({ archived: true }).where(eq(schema.threads.id, archived));

    const anaCookie = await signIn(worker, db, "ana@tyrell.test");
    const beaCookie = await signIn(worker, db, "bea@tyrell.test");
    await setState(read, anaCookie, { read: true });
    await setState(snoozed, anaCookie, {
      snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });

    type Counts = {
      mailboxes: { mailboxId: string; unread: number; lanes: Record<string, number> }[];
    };
    const counts = async (cookie: string) => (await get<Counts>("/counts", cookie)).mailboxes;
    const lanes = (needs_reply: number, fyi: number, unsure: number) => ({
      needs_reply,
      waiting_on_them: 0,
      fyi,
      noise: 0,
      unsure,
    });

    // Catches counting read, snoozed or archived threads, low-confidence triage in its bucket
    // instead of Unsure, and mailboxes the member cannot see.
    expect(await counts(anaCookie)).toEqual(
      expect.arrayContaining([
        { mailboxId: sales.id, unread: 4, lanes: lanes(2, 0, 1) },
        { mailboxId: support.id, unread: 0, lanes: lanes(0, 0, 0) },
      ]),
    );
    expect(await counts(anaCookie)).toHaveLength(2);
    // Read and snooze are Ana's: Bea counts both, and only the mailbox she was granted.
    expect(await counts(beaCookie)).toEqual([
      { mailboxId: sales.id, unread: 6, lanes: lanes(3, 1, 1) },
    ]);

    await setState(sure, anaCookie, { read: true });
    expect((await counts(anaCookie)).find((m) => m.mailboxId === sales.id)).toEqual({
      mailboxId: sales.id,
      unread: 3,
      lanes: lanes(1, 0, 1),
    });
  });
});
