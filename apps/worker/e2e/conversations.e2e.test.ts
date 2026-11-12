// The helpdesk workflow (ADR 0021) against the real Worker and Postgres: explicit actions, the
// status rule on ingest, resolve filing the mail through the outbox, and the snooze clock.
import { randomUUID } from "node:crypto";
import { addLocation, schema, upsertFolder } from "@omni/db";
import { and, eq } from "drizzle-orm";
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
  type TestDb,
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
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": `key-${randomUUID()}`,
      ...init.headers,
    },
  });
}

const post = (path: string, cookie: string, body?: unknown) =>
  api(path, cookie, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const put = (path: string, cookie: string, body: unknown) =>
  api(path, cookie, { method: "PUT", body: JSON.stringify(body) });

interface Conversation {
  status: string;
  assigneeMemberId: string | null;
  priority: string;
  snoozedUntil: string | null;
  firstRespondedAt: string | null;
  tags: { id: string; name: string }[];
  events: { kind: string; actorMemberId: string | null; data: Record<string, unknown> }[];
}

async function conversation(threadId: string, cookie: string) {
  const response = await api(`/threads/${threadId}/conversation`, cookie);
  expect(response.status).toBe(200);
  return (await response.json()) as Conversation;
}

async function queued(db: TestDb, mailboxId: string) {
  return db
    .select({ kind: schema.mailActions.kind, payload: schema.mailActions.payload })
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, mailboxId))
    .orderBy(schema.mailActions.createdAt);
}

/** A support inbox with two agents who can see it and one teammate who cannot. */
async function supportDesk(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM).catch(() => undefined);
  const inbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  const carl = await createMember(db, org.id, `carl@${slug}.test`);
  await grant(db, org.id, inbox.id, ana.id);
  await grant(db, org.id, inbox.id, bea.id);
  const archive = await upsertFolder(db, {
    orgId: org.id,
    mailboxId: inbox.id,
    path: "Archive",
    role: "archive",
    uidvalidity: 1_700_000_000,
    uidnext: 1000,
    highestModseq: null,
  });
  return {
    org,
    inbox,
    ana,
    bea,
    carl,
    archive,
    anaCookie: await signIn(worker, db, `ana@${slug}.test`),
    carlCookie: await signIn(worker, db, `carl@${slug}.test`),
  };
}

describe("explicit actions", () => {
  test("resolve archives only the INBOX copies once, and reopen moves them back to INBOX", async () => {
    const { db } = database;
    const desk = await supportDesk("resolve");
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Refund",
      fromAddress: "luis@client.test",
      uid: 1,
    });
    // Our reply's Sent copy is in the same conversation: resolve must leave Sent alone.
    await seedMessage(db, desk.inbox, {
      subject: "Re: Refund",
      fromAddress: desk.inbox.address,
      folder: "Sent",
      uid: 1,
      threadId: asked.threadId,
    });

    const resolved = await post(`/threads/${asked.threadId}/resolve`, desk.anaCookie);
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      changed: true,
      conversation: { status: "resolved" },
    });
    // A double click: nothing changes, nothing more is queued.
    const again = await post(`/threads/${asked.threadId}/resolve`, desk.anaCookie);
    expect(await again.json()).toMatchObject({ changed: false });

    expect(await queued(db, desk.inbox.id)).toEqual([
      {
        kind: "archive",
        payload: { folder: "INBOX", uidValidity: "1700000000", uids: [1] },
      },
    ]);
    const [thread] = await db
      .select({ archived: schema.threads.archived })
      .from(schema.threads)
      .where(eq(schema.threads.id, asked.threadId));
    expect(thread!.archived).toBe(true);
    await mailService.waitFor(1);

    // The mail service filed it: the archive ran and the copy now lives in Archive.
    await db
      .update(schema.mailActions)
      .set({ status: "done" })
      .where(eq(schema.mailActions.mailboxId, desk.inbox.id));
    await db
      .delete(schema.messageLocations)
      .where(eq(schema.messageLocations.messageId, asked.messageId));
    await addLocation(db, {
      orgId: desk.org.id,
      mailboxId: desk.inbox.id,
      folderId: desk.archive.id,
      uid: 7,
      messageId: asked.messageId,
      flags: [],
      modseq: null,
    });

    const reopened = await post(`/threads/${asked.threadId}/reopen`, desk.anaCookie);
    expect(await reopened.json()).toMatchObject({
      changed: true,
      conversation: { status: "open" },
    });
    expect((await queued(db, desk.inbox.id)).at(-1)).toEqual({
      kind: "move",
      payload: { folder: "Archive", uidValidity: "1700000000", uids: [7], destination: "INBOX" },
    });

    const timeline = await conversation(asked.threadId, desk.anaCookie);
    expect(timeline.events.map((e) => [e.kind, e.data.from, e.data.to, e.actorMemberId])).toEqual([
      ["status", "open", "resolved", desk.ana.id],
      ["status", "resolved", "open", desk.ana.id],
    ]);
  });

  test("assign, claim, priority and tags each write one event and refuse what the inbox does not allow", async () => {
    const { db } = database;
    const desk = await supportDesk("assign");
    const { threadId } = await seedMessage(db, desk.inbox, {
      subject: "Login broken",
      fromAddress: "maria@client.test",
      uid: 1,
    });

    // Carl cannot see the inbox: he can neither act on it nor be given it.
    expect((await post(`/threads/${threadId}/claim`, desk.carlCookie)).status).toBe(404);
    expect((await api(`/threads/${threadId}/conversation`, desk.carlCookie)).status).toBe(404);
    expect(
      (await put(`/threads/${threadId}/assignee`, desk.anaCookie, { memberId: desk.carl.id }))
        .status,
    ).toBe(422);

    expect((await post(`/threads/${threadId}/claim`, desk.anaCookie)).status).toBe(200);
    await put(`/threads/${threadId}/assignee`, desk.anaCookie, { memberId: desk.bea.id });
    await put(`/threads/${threadId}/assignee`, desk.anaCookie, { memberId: desk.bea.id });
    await put(`/threads/${threadId}/priority`, desk.anaCookie, { priority: "urgent" });

    const created = await post(`/mailboxes/${desk.inbox.id}/tags`, desk.anaCookie, {
      name: "Billing",
    });
    expect(created.status).toBe(201);
    const { tag } = (await created.json()) as { tag: { id: string } };
    // Same name, other case: the same tag, not a second one.
    const twice = await post(`/mailboxes/${desk.inbox.id}/tags`, desk.anaCookie, {
      name: "billing",
    });
    expect(twice.status).toBe(200);
    expect(((await twice.json()) as { tag: { id: string } }).tag.id).toBe(tag.id);

    await post(`/threads/${threadId}/tags`, desk.anaCookie, { tagId: tag.id });
    await post(`/threads/${threadId}/tags`, desk.anaCookie, { tagId: tag.id });

    // A tag from another inbox cannot be put on this conversation.
    const elsewhere = await supportDesk("assign-other");
    const foreign = (await (
      await post(`/mailboxes/${elsewhere.inbox.id}/tags`, elsewhere.anaCookie, { name: "Spam" })
    ).json()) as { tag: { id: string } };
    expect(
      (await post(`/threads/${threadId}/tags`, desk.anaCookie, { tagId: foreign.tag.id })).status,
    ).toBe(422);

    const state = await conversation(threadId, desk.anaCookie);
    expect(state).toMatchObject({ assigneeMemberId: desk.bea.id, priority: "urgent" });
    expect(state.tags.map((t) => t.name)).toEqual(["Billing"]);
    expect(state.events.map((e) => [e.kind, e.data.to ?? e.data.tagId])).toEqual([
      ["assigned", desk.ana.id],
      ["assigned", desk.bea.id],
      ["priority", "urgent"],
      ["tag_added", tag.id],
    ]);

    const removed = await api(`/threads/${threadId}/tags/${tag.id}`, desk.anaCookie, {
      method: "DELETE",
    });
    expect(await removed.json()).toMatchObject({ changed: true });
    expect((await conversation(threadId, desk.anaCookie)).tags).toEqual([]);
  });

  test("undoing a resolve before the archive runs cancels it, so the mail never leaves INBOX", async () => {
    const { db } = database;
    const desk = await supportDesk("undo");
    const { threadId } = await seedMessage(db, desk.inbox, {
      subject: "Undo me",
      fromAddress: "x@client.test",
      uid: 1,
    });
    await post(`/threads/${threadId}/resolve`, desk.anaCookie);
    const [archive] = await db
      .select({ runAfter: schema.mailActions.runAfter })
      .from(schema.mailActions)
      .where(eq(schema.mailActions.mailboxId, desk.inbox.id));
    // Not claimable yet: the undo window is still open.
    expect(archive!.runAfter.getTime()).toBeGreaterThan(Date.now());

    await post(`/threads/${threadId}/reopen`, desk.anaCookie);
    expect(await queued(db, desk.inbox.id)).toEqual([]);
    const [thread] = await db
      .select({ archived: schema.threads.archived, status: schema.threads.status })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId));
    expect(thread).toEqual({ archived: false, status: "open" });
  });

  test("a retried request does not undo a teammate's change made in between", async () => {
    const { db } = database;
    const desk = await supportDesk("retry");
    const beaCookie = await signIn(worker, db, "bea@retry.test");
    const { threadId } = await seedMessage(db, desk.inbox, {
      subject: "Retry",
      fromAddress: "x@client.test",
      uid: 1,
    });
    const key = { "idempotency-key": `assign-${randomUUID()}` };
    const assignToAna = () =>
      api(`/threads/${threadId}/assignee`, desk.anaCookie, {
        method: "PUT",
        headers: key,
        body: JSON.stringify({ memberId: desk.ana.id }),
      });
    expect(await (await assignToAna()).json()).toMatchObject({ changed: true });
    await put(`/threads/${threadId}/assignee`, beaCookie, { memberId: desk.bea.id });
    // Ana's client retries after a timeout: Bea keeps it.
    expect(await (await assignToAna()).json()).toMatchObject({ changed: false });
    expect((await conversation(threadId, desk.anaCookie)).assigneeMemberId).toBe(desk.bea.id);
  });

  test("a personal mailbox has no conversation workflow", async () => {
    const { db } = database;
    const desk = await supportDesk("personal");
    const own = await createMailbox(db, desk.org.id, desk.ana.id + "@personal.test", "personal");
    await grant(db, desk.org.id, own.id, desk.ana.id);
    const { threadId } = await seedMessage(db, own, {
      subject: "Hi",
      fromAddress: "mom@home.test",
      uid: 1,
    });
    expect((await post(`/threads/${threadId}/resolve`, desk.anaCookie)).status).toBe(409);
  });
});

describe("ingest", () => {
  function created(
    desk: { org: { id: string }; inbox: { id: string } },
    threadId: string,
    messageId: string,
    folderRole: "inbox" | "sent" = "inbox",
  ) {
    return postMailEvents(worker, {
      events: [
        {
          type: "message.created",
          orgId: desk.org.id,
          mailboxId: desk.inbox.id,
          threadId,
          messageId,
          folderRole,
        },
      ],
    });
  }

  test("a reply goes pending with a first response, the customer reopens it, an auto-reply does not, and a redelivered old message changes nothing", async () => {
    const { db } = database;
    const desk = await supportDesk("ingest");
    const t0 = Date.now() - 60_000;
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Invoice",
      fromAddress: "luis@client.test",
      uid: 1,
      sentAt: new Date(t0),
    });
    expect((await created(desk, asked.threadId, asked.messageId)).status).toBe(202);
    expect((await conversation(asked.threadId, desk.anaCookie)).status).toBe("open");

    const reply = await seedMessage(db, desk.inbox, {
      subject: "Re: Invoice",
      fromAddress: desk.inbox.address,
      folder: "Sent",
      uid: 1,
      threadId: asked.threadId,
      sentAt: new Date(t0 + 10_000),
    });
    await created(desk, asked.threadId, reply.messageId, "sent");
    let state = await conversation(asked.threadId, desk.anaCookie);
    expect(state.status).toBe("pending");
    expect(state.firstRespondedAt).toBe(new Date(t0 + 10_000).toISOString());

    // The event for the customer's first message arrives again (at-least-once): still pending.
    await created(desk, asked.threadId, asked.messageId);
    expect((await conversation(asked.threadId, desk.anaCookie)).status).toBe("pending");

    // An out-of-office reply is not the customer answering.
    const away = await seedMessage(db, desk.inbox, {
      subject: "Out of office",
      fromAddress: "luis@client.test",
      uid: 2,
      threadId: asked.threadId,
      sentAt: new Date(t0 + 20_000),
    });
    await db
      .update(schema.messages)
      .set({ automated: true })
      .where(eq(schema.messages.id, away.messageId));
    await created(desk, asked.threadId, away.messageId);
    expect((await conversation(asked.threadId, desk.anaCookie)).status).toBe("pending");

    // Resolved, then the customer writes back: open again, and its archived mail heads back.
    await post(`/threads/${asked.threadId}/resolve`, desk.anaCookie);
    const back = await seedMessage(db, desk.inbox, {
      subject: "Re: Invoice",
      fromAddress: "luis@client.test",
      uid: 3,
      threadId: asked.threadId,
      sentAt: new Date(t0 + 30_000),
    });
    await created(desk, asked.threadId, back.messageId);
    state = await conversation(asked.threadId, desk.anaCookie);
    expect(state.status).toBe("open");
    expect(state.events.map((e) => [e.kind, e.data.to ?? null, e.actorMemberId])).toEqual([
      ["status", "pending", null],
      ["first_response", null, null],
      ["status", "resolved", desk.ana.id],
      ["status", "open", null],
    ]);
  });

  test("a Sent copy indexed after the customer already answered does not make it pending, but counts as the first response", async () => {
    const { db } = database;
    const desk = await supportDesk("late-sent");
    const t0 = Date.now() - 60_000;
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Q",
      fromAddress: "x@client.test",
      uid: 1,
      sentAt: new Date(t0),
    });
    const reply = await seedMessage(db, desk.inbox, {
      subject: "Re: Q",
      fromAddress: desk.inbox.address,
      folder: "Sent",
      uid: 1,
      threadId: asked.threadId,
      sentAt: new Date(t0 + 1_000),
    });
    const answer = await seedMessage(db, desk.inbox, {
      subject: "Re: Q",
      fromAddress: "x@client.test",
      uid: 2,
      threadId: asked.threadId,
      sentAt: new Date(t0 + 2_000),
    });
    await created(desk, asked.threadId, answer.messageId);
    await created(desk, asked.threadId, reply.messageId, "sent");
    const state = await conversation(asked.threadId, desk.anaCookie);
    expect(state.status).toBe("open");
    // It still answered the first question.
    expect(state.firstRespondedAt).toBe(new Date(t0 + 1_000).toISOString());
  });
});

test("the minute cron wakes a snooze that is over, and only that one", async () => {
  const { db } = database;
  const desk = await supportDesk("snooze");
  const soon = await seedMessage(db, desk.inbox, {
    subject: "A",
    fromAddress: "a@client.test",
    uid: 1,
  });
  const later = await seedMessage(db, desk.inbox, {
    subject: "B",
    fromAddress: "b@client.test",
    uid: 2,
  });
  const past = await post(`/threads/${soon.threadId}/snooze`, desk.anaCookie, {
    until: new Date(Date.now() - 1000).toISOString(),
  });
  expect(past.status).toBe(422);

  await post(`/threads/${soon.threadId}/snooze`, desk.anaCookie, {
    until: new Date(Date.now() + 1500).toISOString(),
  });
  await post(`/threads/${later.threadId}/snooze`, desk.anaCookie, {
    until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const result = await worker.server.getWorker().scheduled({ cron: "* * * * *" });
  expect(result.outcome).toBe("ok");
  expect((await conversation(soon.threadId, desk.anaCookie)).status).toBe("open");
  expect((await conversation(later.threadId, desk.anaCookie)).status).toBe("snoozed");
  const events = await db
    .select({
      actor: schema.conversationEvents.actorMemberId,
      data: schema.conversationEvents.data,
    })
    .from(schema.conversationEvents)
    .where(
      and(
        eq(schema.conversationEvents.threadId, soon.threadId),
        eq(schema.conversationEvents.kind, "status"),
      ),
    );
  expect(events.map((e) => [e.data.to, e.actor])).toEqual([
    ["snoozed", desk.ana.id],
    ["open", null],
  ]);
});
