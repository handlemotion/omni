import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
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

function post(path: string, cookie: string, body?: unknown) {
  return fetch(new URL(`/api${path}`, worker.url), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function setUp(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  const inbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const person = async (name: string) => {
    const member = await createMember(db, org.id, `${name}@${slug}.test`);
    await db
      .update(schema.users)
      .set({ name })
      .where(eq(schema.users.email, `${name}@${slug}.test`));
    const own = await createMailbox(db, org.id, `${name}@${slug}.test`, "personal");
    await db.insert(schema.mailboxAccess).values([
      { orgId: org.id, mailboxId: inbox.id, memberId: member.id },
      { orgId: org.id, mailboxId: own.id, memberId: member.id, role: "owner" },
    ]);
    await db
      .insert(schema.memberPreferences)
      .values({ memberId: member.id, orgId: org.id, undoSendSeconds: 60 });
    return { member, mailbox: own, cookie: await signIn(worker, db, `${name}@${slug}.test`) };
  };
  const ana = await person("ana");
  const bea = await person("bea");
  const customerHeader = `<order-${slug}@customer.test>`;
  const seeded = await seedMessage(db, inbox, {
    subject: "Bulk pricing",
    fromAddress: "buyer@customer.test",
    to: [inbox.address],
    uid: 1,
    messageId: customerHeader,
  });
  await db
    .update(schema.threads)
    .set({ assigneeMemberId: bea.member.id })
    .where(eq(schema.threads.id, seeded.threadId));
  return { db, inbox, ana, bea, threadId: seeded.threadId, customerHeader };
}

async function conversation(threadId: string) {
  const [row] = await database.db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId));
  return row!;
}

test("a reply from Ana's own mailbox goes out from it, threaded, and hands the conversation to her", async () => {
  const { db, ana, bea, threadId, customerHeader } = await setUp("handoff");
  const body = {
    mailboxId: ana.mailbox.id,
    to: ["buyer@customer.test"],
    cc: ["finance@customer.test"],
    text: "I'll take it from here.",
  };

  const stolen = await post(`/threads/${threadId}/handoff`, ana.cookie, {
    ...body,
    mailboxId: bea.mailbox.id,
  });
  expect(stolen.status).toBe(404);
  expect(
    await db
      .select()
      .from(schema.mailActions)
      .where(eq(schema.mailActions.memberId, ana.member.id)),
  ).toEqual([]);
  expect((await conversation(threadId)).status).toBe("open");

  const sent = await post(`/threads/${threadId}/handoff`, ana.cookie, body);
  expect(sent.status).toBe(202);
  const { actionId, messageIdHeader } = (await sent.json()) as {
    actionId: string;
    messageIdHeader: string;
  };
  const [action] = await db
    .select()
    .from(schema.mailActions)
    .where(eq(schema.mailActions.id, actionId));
  expect(action!.mailboxId).toBe(ana.mailbox.id);
  expect(action!.payload).toMatchObject({
    from: ana.mailbox.address,
    fromName: "ana",
    to: ["buyer@customer.test"],
    cc: ["finance@customer.test"],
    subject: "Re: Bulk pricing",
    inReplyTo: customerHeader,
    references: [customerHeader],
    handoffThreadId: threadId,
    messageId: messageIdHeader,
  });
  expect(action!.payload).not.toHaveProperty("inReplyToMessageId");
  expect(new Date(action!.runAfter).getTime()).toBeGreaterThan(Date.now());

  const after = await conversation(threadId);
  expect(after.assigneeMemberId).toBe(ana.member.id);
  expect(after.status).toBe("resolved");
  const [handoff] = await db
    .select()
    .from(schema.conversationEvents)
    .where(
      and(
        eq(schema.conversationEvents.threadId, threadId),
        eq(schema.conversationEvents.kind, "handoff"),
      ),
    );
  expect(handoff).toMatchObject({
    actorMemberId: ana.member.id,
    data: {
      mailboxId: ana.mailbox.id,
      address: ana.mailbox.address,
      actionId,
      previous: { status: "open", assigneeMemberId: bea.member.id },
    },
  });
  const timeline = await fetch(new URL(`/api/threads/${threadId}/conversation`, worker.url), {
    headers: { cookie: bea.cookie },
  });
  expect(timeline.status).toBe(200);
  const { events } = (await timeline.json()) as { events: { kind: string }[] };
  expect(events.map((e) => e.kind)).toContain("handoff");
});

test("cancelling the hand-off's send gives the conversation back to the team", async () => {
  const { db, ana, bea, threadId } = await setUp("handoff-undo");
  const sent = await post(`/threads/${threadId}/handoff`, ana.cookie, {
    mailboxId: ana.mailbox.id,
    to: ["buyer@customer.test"],
    text: "I'll take it from here.",
  });
  expect(sent.status).toBe(202);
  const { actionId } = (await sent.json()) as { actionId: string };
  expect((await conversation(threadId)).status).toBe("resolved");

  const cancel = await post(`/actions/${actionId}/cancel`, ana.cookie);
  expect(cancel.status).toBe(200);
  const back = await conversation(threadId);
  expect(back.status).toBe("open");
  expect(back.assigneeMemberId).toBe(bea.member.id);
  const archives = await db
    .select()
    .from(schema.mailActions)
    .where(
      and(eq(schema.mailActions.mailboxId, back.mailboxId), eq(schema.mailActions.kind, "archive")),
    );
  expect(archives).toEqual([]);
});
