// The helpdesk workflow (ADR 0021) against the real Worker and Postgres: explicit actions, the
// status rule on ingest, resolve filing the mail through the outbox, and the snooze clock.
import { randomUUID } from "node:crypto";
import { addLocation, schema, upsertFolder } from "@omni/db";
import { and, eq, sql } from "drizzle-orm";
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
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    // Every desk signs its teammates in from one IP; security.e2e covers the sign-in limit.
    vars: { RATE_LIMIT_AUTH: "off" },
  });
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

  test("two teammates claiming an unassigned conversation at once: one gets it, the other is told who", async () => {
    const { db } = database;
    const desk = await supportDesk("claim-race");
    const beaCookie = await signIn(worker, db, "bea@claim-race.test");
    const { threadId } = await seedMessage(db, desk.inbox, {
      subject: "Invoice missing",
      fromAddress: "maria@client.test",
      uid: 1,
    });

    // Both saw it unassigned and pressed Claim together.
    const responses = await Promise.all(
      [desk.anaCookie, beaCookie].map((cookie) =>
        post(`/threads/${threadId}/claim`, cookie, { expectedAssignee: null }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const owner = (await conversation(threadId, desk.anaCookie)).assigneeMemberId;
    expect([desk.ana.id, desk.bea.id]).toContain(owner);
    const refused = responses.find((r) => r.status === 409)!;
    expect(await refused.json()).toMatchObject({ conversation: { assigneeMemberId: owner } });

    // The winner pressing it again (a double click) is no conflict.
    const ownerCookie = owner === desk.ana.id ? desk.anaCookie : beaCookie;
    const again = await post(`/threads/${threadId}/claim`, ownerCookie, { expectedAssignee: null });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ changed: false });

    // Exactly one assignment on the timeline.
    const events = (await conversation(threadId, desk.anaCookie)).events;
    expect(events.filter((e) => e.kind === "assigned").map((e) => e.data.to)).toEqual([owner]);

    // A claim with no body (today's web app) still takes it over, as it always did.
    const otherCookie = owner === desk.ana.id ? beaCookie : desk.anaCookie;
    expect((await post(`/threads/${threadId}/claim`, otherCookie)).status).toBe(200);
    expect((await conversation(threadId, desk.anaCookie)).assigneeMemberId).not.toBe(owner);
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
    until: new Date(Date.now() + 60_000).toISOString(),
  });
  await post(`/threads/${later.threadId}/snooze`, desk.anaCookie, {
    until: new Date(Date.now() + 3_600_000).toISOString(),
  });
  // The minute passes: Ana's snooze is now due, as if the clock had moved on.
  await db
    .update(schema.threads)
    .set({ snoozedUntil: new Date(Date.now() - 1000) })
    .where(eq(schema.threads.id, soon.threadId));

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

describe("views and counts", () => {
  type Page = {
    conversations: { id: string; tags: { id: string }[] }[];
    nextCursor: string | null;
  };

  async function view(cookie: string, mailboxId: string, query: string) {
    const ids: string[] = [];
    let cursor: string | null = null;
    // Pages of two, so a keyset bug drops or repeats a row.
    do {
      const response = await api(
        `/conversations?mailboxId=${mailboxId}&limit=2&${query}${cursor ? `&cursor=${cursor}` : ""}`,
        cookie,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as Page;
      ids.push(...page.conversations.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }

  test("each view holds exactly its conversations, pages without gaps, and counts agree", async () => {
    const { db } = database;
    const desk = await supportDesk("views");
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const seed = async (n: number) =>
      (
        await seedMessage(db, desk.inbox, {
          subject: `Case ${n}`,
          fromAddress: `c${n}@client.test`,
          uid: n,
          sentAt: at(100 - n),
        })
      ).threadId;
    // Newest last: c1 is the oldest.
    const [c1, c2, c3, c4, c5, c6, c7] = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(seed));

    await post(`/threads/${c2}/claim`, desk.anaCookie);
    await put(`/threads/${c3}/assignee`, desk.anaCookie, { memberId: desk.bea.id });
    await post(`/threads/${c4}/claim`, desk.anaCookie);
    await db.update(schema.threads).set({ status: "pending" }).where(eq(schema.threads.id, c4!));
    await post(`/threads/${c5}/snooze`, desk.anaCookie, {
      until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await post(`/threads/${c6}/resolve`, desk.anaCookie);
    // SLA: c7 is overdue, c1 due in 10 minutes, c3 due tomorrow (not at risk). Postgres keeps
    // microseconds that a JS Date drops; a cursor built from a Date repeats the boundary row.
    await db
      .update(schema.threads)
      .set({ firstResponseDueAt: sql`now() - interval '5 minutes 0.000123 seconds'` })
      .where(eq(schema.threads.id, c7!));
    await db
      .update(schema.threads)
      .set({ nextResponseDueAt: sql`now() + interval '10 minutes 0.000456 seconds'` })
      .where(eq(schema.threads.id, c1!));
    await db
      .update(schema.threads)
      .set({ resolutionDueAt: at(-24 * 60) })
      .where(eq(schema.threads.id, c3!));
    const { tag } = (await (
      await post(`/mailboxes/${desk.inbox.id}/tags`, desk.anaCookie, { name: "VIP" })
    ).json()) as { tag: { id: string } };
    await post(`/threads/${c1}/tags`, desk.anaCookie, { tagId: tag.id });
    await post(`/threads/${c6}/tags`, desk.anaCookie, { tagId: tag.id });

    const box = desk.inbox.id;
    const expected = {
      unassigned: [c7, c1],
      mine: [c4, c2],
      open: [c7, c3, c2, c1],
      pending: [c4],
      snoozed: [c5],
      resolved: [c6],
      sla_at_risk: [c7, c1],
    };
    for (const [name, ids] of Object.entries(expected)) {
      expect([name, await view(desk.anaCookie, box, `view=${name}`)]).toEqual([name, ids]);
    }
    expect(await view(desk.anaCookie, box, `view=all&tagId=${tag.id}`)).toEqual([c6, c1]);
    expect(await view(desk.anaCookie, box, `view=open&tagId=${tag.id}`)).toEqual([c1]);
    // Carl cannot see the inbox: every view is empty for him.
    expect(await view(desk.carlCookie, box, "view=open")).toEqual([]);

    const counts = (await (
      await api(`/conversations/counts?mailboxId=${box}`, desk.anaCookie)
    ).json()) as {
      counts: { mailboxId: string; views: Record<string, number>; tags: Record<string, number> }[];
    };
    expect(counts.counts).toEqual([
      {
        orgId: desk.org.id,
        mailboxId: box,
        views: { unassigned: 2, mine: 2, open: 4, pending: 1, snoozed: 1, sla_at_risk: 2 },
        tags: { [tag.id]: 1 },
      },
    ]);
  });
});

describe("notes and notifications", () => {
  type Notifications = {
    notifications: { id: string; kind: string; threadId: string; noteId: string | null }[];
    unread: number;
  };

  test("mentions, assignment and customer replies notify the right teammate once, and only while they can see it", async () => {
    const { db } = database;
    const desk = await supportDesk("notes");
    const beaCookie = await signIn(worker, db, "bea@notes.test");
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Broken export",
      fromAddress: "luis@client.test",
      uid: 1,
      sentAt: new Date(Date.now() - 60_000),
    });

    // Carl cannot see the inbox: his mention is dropped, Ana's own mention notifies nobody.
    const created = await post(`/threads/${asked.threadId}/notes`, desk.anaCookie, {
      body: "@Bea can you check the CSV path? cc @Carl",
      mentions: [desk.bea.id, desk.carl.id, desk.ana.id],
    });
    expect(created.status).toBe(201);
    const { note } = (await created.json()) as { note: { id: string; mentions: string[] } };
    expect(note.mentions).toEqual([desk.bea.id, desk.ana.id]);
    expect(
      (await post(`/threads/${asked.threadId}/notes`, desk.carlCookie, { body: "x" })).status,
    ).toBe(404);

    // Claiming notifies nobody; handing it to Bea notifies Bea.
    await post(`/threads/${asked.threadId}/claim`, desk.anaCookie);
    await put(`/threads/${asked.threadId}/assignee`, desk.anaCookie, { memberId: desk.bea.id });

    // Luis writes back on Bea's conversation; the event is delivered twice.
    const back = await seedMessage(db, desk.inbox, {
      subject: "Re: Broken export",
      fromAddress: "luis@client.test",
      uid: 2,
      threadId: asked.threadId,
    });
    const event = {
      events: [
        {
          type: "message.created" as const,
          orgId: desk.org.id,
          mailboxId: desk.inbox.id,
          threadId: asked.threadId,
          messageId: back.messageId,
          folderRole: "inbox" as const,
        },
      ],
    };
    await postMailEvents(worker, event);
    await postMailEvents(worker, event);

    const bea = (await (await api("/notifications", beaCookie)).json()) as Notifications;
    expect(bea.notifications.map((n) => [n.kind, n.threadId, n.noteId])).toEqual([
      ["customer_reply", asked.threadId, null],
      ["assigned", asked.threadId, null],
      ["mention", asked.threadId, note.id],
    ]);
    expect(bea.unread).toBe(3);
    // One per page walks the same list, even for notifications inside one millisecond: the
    // cursor keeps Postgres's microseconds, where a JS Date would skip the older ones.
    for (const [i, n] of bea.notifications.entries()) {
      await db
        .update(schema.notifications)
        .set({
          createdAt: sql`date_trunc('milliseconds', now()) + make_interval(secs => ${(3 - i) * 0.0001})`,
        })
        .where(eq(schema.notifications.id, n.id));
    }
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await api(`/notifications?limit=1${cursor ? `&cursor=${cursor}` : ""}`, beaCookie)
      ).json()) as Notifications & { nextCursor: string | null };
      paged.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
    } while (cursor && paged.length < 10);
    const whole = (await (await api("/notifications", beaCookie)).json()) as Notifications;
    expect(paged).toEqual(whole.notifications.map((n) => n.id));
    expect(paged).toHaveLength(3);
    const ana = (await (await api("/notifications", desk.anaCookie)).json()) as Notifications;
    expect(ana.notifications).toEqual([]);
    const carl = (await (await api("/notifications", desk.carlCookie)).json()) as Notifications;
    expect(carl.notifications).toEqual([]);

    // Read one, then all.
    await post("/notifications/read", beaCookie, { ids: [bea.notifications[0]!.id] });
    expect(
      ((await (await api("/notifications?unread=true", beaCookie)).json()) as Notifications).unread,
    ).toBe(2);
    await post("/notifications/read", beaCookie, {});
    expect(((await (await api("/notifications", beaCookie)).json()) as Notifications).unread).toBe(
      0,
    );

    // Only the author edits or deletes a note; deleting takes its timeline event with it.
    const patch = await api(`/threads/${asked.threadId}/notes/${note.id}`, beaCookie, {
      method: "PATCH",
      body: JSON.stringify({ body: "hijacked" }),
    });
    expect(patch.status).toBe(404);
    let state = await conversation(asked.threadId, desk.anaCookie);
    expect((state as unknown as { notes: { body: string }[] }).notes.map((n) => n.body)).toEqual([
      "@Bea can you check the CSV path? cc @Carl",
    ]);
    expect(
      (
        await api(`/threads/${asked.threadId}/notes/${note.id}`, desk.anaCookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    state = await conversation(asked.threadId, desk.anaCookie);
    expect(state.events.some((e) => e.kind === "note")).toBe(false);

    // Bea leaves the inbox: its notifications go with her access.
    await db
      .delete(schema.mailboxAccess)
      .where(
        and(
          eq(schema.mailboxAccess.mailboxId, desk.inbox.id),
          eq(schema.mailboxAccess.memberId, desk.bea.id),
        ),
      );
    expect(
      ((await (await api("/notifications", beaCookie)).json()) as Notifications).notifications,
    ).toEqual([]);
  });
});

describe("note notifications", () => {
  type Kinds = { notifications: { kind: string; noteId: string | null }[] };

  test("a note reaches the assignee and earlier note authors once, never its author, and goes with it", async () => {
    const { db } = database;
    const desk = await supportDesk("following");
    const beaCookie = await signIn(worker, db, "bea@following.test");
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Refund status",
      fromAddress: "luis@client.test",
      uid: 1,
      sentAt: new Date(Date.now() - 60_000),
    });
    const kinds = async (cookie: string) =>
      ((await (await api("/notifications", cookie)).json()) as Kinds).notifications.map((n) => [
        n.kind,
        n.noteId,
      ]);
    const note = async (cookie: string, body: string, mentions: string[] = []) =>
      (
        (await (
          await post(`/threads/${asked.threadId}/notes`, cookie, { body, mentions })
        ).json()) as {
          note: { id: string };
        }
      ).note.id;

    // Bea holds it. Ana's note reaches her as a note; Ana hears nothing of her own.
    await put(`/threads/${asked.threadId}/assignee`, desk.anaCookie, { memberId: desk.bea.id });
    const first = await note(desk.anaCookie, "Customer called about this");
    expect(await kinds(beaCookie)).toEqual([
      ["note", first],
      ["assigned", null],
    ]);
    expect(await kinds(desk.anaCookie)).toEqual([]);

    // Bea answers: Ana wrote on it before, so she hears. Mentioning Ana gives her one, not two.
    const second = await note(beaCookie, "@Ana on it", [desk.ana.id]);
    expect(await kinds(desk.anaCookie)).toEqual([["mention", second]]);
    expect((await kinds(beaCookie)).length).toBe(2);

    // Deleting the note takes its notifications with it.
    await api(`/threads/${asked.threadId}/notes/${first}`, desk.anaCookie, { method: "DELETE" });
    expect(await kinds(beaCookie)).toEqual([["assigned", null]]);
  });
});

describe("SLAs", () => {
  const minutes = (n: number) => n * 60_000;

  // One desk for every SLA test (sign-ins are rate limited); each test gets its own inbox.
  let team: Awaited<ReturnType<typeof supportDesk>> & { beaCookie: string };
  beforeAll(async () => {
    const { db } = database;
    const desk = await supportDesk("sla");
    await db
      .update(schema.members)
      .set({ role: "admin" })
      .where(eq(schema.members.id, desk.ana.id));
    team = { ...desk, beaCookie: await signIn(worker, database.db, "bea@sla.test") };
  });

  /** A new inbox of the desk that Ana and Bea see, connected a day ago. Ana is an org admin. */
  async function slaDesk(name: string) {
    const { db } = database;
    const inbox = await createMailbox(db, team.org.id, `${name}@sla.test`);
    await grant(db, team.org.id, inbox.id, team.ana.id);
    await grant(db, team.org.id, inbox.id, team.bea.id);
    await db
      .update(schema.mailboxes)
      .set({ createdAt: new Date(Date.now() - minutes(24 * 60)) })
      .where(eq(schema.mailboxes.id, inbox.id));
    return { ...team, inbox };
  }

  function delivered(
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

  type Due = {
    firstResponseDueAt: string | null;
    nextResponseDueAt: string | null;
    resolutionDueAt: string | null;
  };
  const dueOf = async (threadId: string, cookie: string) => {
    const { firstResponseDueAt, nextResponseDueAt, resolutionDueAt } = (await conversation(
      threadId,
      cookie,
    )) as unknown as Due;
    return { firstResponseDueAt, nextResponseDueAt, resolutionDueAt };
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  test("only owners and admins change targets and hours; teammates read them; others see nothing", async () => {
    const desk = await slaDesk("sla-settings");
    const policy = {
      firstResponseMinutes: 60,
      nextResponseMinutes: 240,
      resolutionMinutes: null,
      businessHoursOnly: false,
    };
    expect((await put(`/mailboxes/${desk.inbox.id}/sla/high`, desk.beaCookie, policy)).status).toBe(
      403,
    );
    expect((await put(`/mailboxes/${desk.inbox.id}/sla/high`, desk.anaCookie, policy)).status).toBe(
      200,
    );
    expect((await put(`/mailboxes/${desk.inbox.id}/sla/vip`, desk.anaCookie, policy)).status).toBe(
      404,
    );
    const badZone = await put(`/mailboxes/${desk.inbox.id}/business-hours`, desk.anaCookie, {
      timezone: "Mars/Olympus",
      windows: [],
    });
    expect(badZone.status).toBe(400);
    const hours = {
      timezone: "America/Mexico_City",
      windows: [{ day: 1, start: "09:00", end: "17:00" }],
      holidays: ["2026-12-25"],
    };
    expect(
      (await put(`/mailboxes/${desk.inbox.id}/business-hours`, desk.anaCookie, hours)).status,
    ).toBe(200);

    const read = await api(`/mailboxes/${desk.inbox.id}/sla`, desk.beaCookie);
    expect(await read.json()).toEqual({
      policies: [{ priority: "high", ...policy }],
      businessHours: hours,
      autoAssign: false,
    });
    // Carl is in the org but cannot see the inbox: not even its settings.
    expect((await api(`/mailboxes/${desk.inbox.id}/sla`, desk.carlCookie)).status).toBe(404);
  });

  test("clocks start on a customer's message, stop on our reply, restart as next response, and clear on resolve", async () => {
    const { db } = database;
    const desk = await slaDesk("sla-clocks");
    await put(`/mailboxes/${desk.inbox.id}/sla/normal`, desk.anaCookie, {
      firstResponseMinutes: 60,
      nextResponseMinutes: 120,
      resolutionMinutes: 600,
      businessHoursOnly: false,
    });
    const t0 = Date.now() - minutes(10);
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Broken",
      fromAddress: "luis@client.test",
      uid: 1,
      sentAt: new Date(t0),
    });
    await delivered(desk, asked.threadId, asked.messageId);
    // Due from when the customer wrote, not from when we indexed it.
    expect(await dueOf(asked.threadId, desk.anaCookie)).toEqual({
      firstResponseDueAt: iso(t0 + minutes(60)),
      nextResponseDueAt: null,
      resolutionDueAt: iso(t0 + minutes(600)),
    });

    // Triage (or a teammate) raises the priority: the urgent targets apply to the same clocks.
    await put(`/mailboxes/${desk.inbox.id}/sla/urgent`, desk.anaCookie, {
      firstResponseMinutes: 15,
      nextResponseMinutes: 30,
      resolutionMinutes: null,
      businessHoursOnly: false,
    });
    await put(`/threads/${asked.threadId}/priority`, desk.anaCookie, { priority: "urgent" });
    expect(await dueOf(asked.threadId, desk.anaCookie)).toEqual({
      firstResponseDueAt: iso(t0 + minutes(15)),
      nextResponseDueAt: null,
      resolutionDueAt: null,
    });
    await put(`/threads/${asked.threadId}/priority`, desk.anaCookie, { priority: "normal" });

    const reply = await seedMessage(db, desk.inbox, {
      subject: "Re: Broken",
      fromAddress: desk.inbox.address,
      folder: "Sent",
      uid: 1,
      threadId: asked.threadId,
      sentAt: new Date(t0 + minutes(5)),
    });
    await delivered(desk, asked.threadId, reply.messageId, "sent");
    expect(await dueOf(asked.threadId, desk.anaCookie)).toEqual({
      firstResponseDueAt: null,
      nextResponseDueAt: null,
      resolutionDueAt: iso(t0 + minutes(600)),
    });

    const t1 = t0 + minutes(8);
    const again = await seedMessage(db, desk.inbox, {
      subject: "Re: Broken",
      fromAddress: "luis@client.test",
      uid: 2,
      threadId: asked.threadId,
      sentAt: new Date(t1),
    });
    await delivered(desk, asked.threadId, again.messageId);
    // The resolution clock keeps running from the first message.
    expect(await dueOf(asked.threadId, desk.anaCookie)).toEqual({
      firstResponseDueAt: null,
      nextResponseDueAt: iso(t1 + minutes(120)),
      resolutionDueAt: iso(t0 + minutes(600)),
    });

    // A looser target moves open conversations' due times at once.
    await put(`/mailboxes/${desk.inbox.id}/sla/normal`, desk.anaCookie, {
      firstResponseMinutes: 60,
      nextResponseMinutes: 180,
      resolutionMinutes: 600,
      businessHoursOnly: false,
    });
    expect((await dueOf(asked.threadId, desk.anaCookie)).nextResponseDueAt).toBe(
      iso(t1 + minutes(180)),
    );

    // A Sent copy indexed late answers only what came before it: the customer has waited since
    // their next message, not since the one it answered.
    const t2 = t0 + minutes(9);
    const more = await seedMessage(db, desk.inbox, {
      subject: "Re: Broken",
      fromAddress: "luis@client.test",
      uid: 3,
      threadId: asked.threadId,
      sentAt: new Date(t2),
    });
    await delivered(desk, asked.threadId, more.messageId);
    const lateCopy = await seedMessage(db, desk.inbox, {
      subject: "Re: Broken",
      fromAddress: desk.inbox.address,
      folder: "Sent",
      uid: 2,
      threadId: asked.threadId,
      sentAt: new Date(t1 + 30_000),
    });
    await delivered(desk, asked.threadId, lateCopy.messageId, "sent");
    expect((await dueOf(asked.threadId, desk.anaCookie)).nextResponseDueAt).toBe(
      iso(t2 + minutes(180)),
    );

    await post(`/threads/${asked.threadId}/resolve`, desk.anaCookie);
    expect(await dueOf(asked.threadId, desk.anaCookie)).toEqual({
      firstResponseDueAt: null,
      nextResponseDueAt: null,
      resolutionDueAt: null,
    });
  });

  test("mail from before the inbox was connected, and auto-replies, start no clock", async () => {
    const { db } = database;
    const desk = await slaDesk("sla-history");
    await put(`/mailboxes/${desk.inbox.id}/sla/normal`, desk.anaCookie, {
      firstResponseMinutes: 60,
      nextResponseMinutes: null,
      resolutionMinutes: null,
      businessHoursOnly: false,
    });
    // A first sync brings in last year's mail: it must not all breach at once.
    const old = await seedMessage(db, desk.inbox, {
      subject: "Old",
      fromAddress: "a@client.test",
      uid: 1,
      sentAt: new Date(Date.now() - minutes(3 * 24 * 60)),
    });
    await delivered(desk, old.threadId, old.messageId);
    expect((await dueOf(old.threadId, desk.anaCookie)).firstResponseDueAt).toBeNull();

    const bounce = await seedMessage(db, desk.inbox, {
      subject: "Out of office",
      fromAddress: "b@client.test",
      uid: 2,
    });
    await db
      .update(schema.messages)
      .set({ automated: true })
      .where(eq(schema.messages.id, bounce.messageId));
    await delivered(desk, bounce.threadId, bounce.messageId);
    expect((await dueOf(bounce.threadId, desk.anaCookie)).firstResponseDueAt).toBeNull();
  });

  test("business hours push a due time past closing to the next opening", async () => {
    const { db } = database;
    const desk = await slaDesk("sla-hours");
    await put(`/mailboxes/${desk.inbox.id}/business-hours`, desk.anaCookie, {
      timezone: "UTC",
      // Open one hour a day, every day.
      windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "09:00", end: "10:00" })),
    });
    await put(`/mailboxes/${desk.inbox.id}/sla/normal`, desk.anaCookie, {
      firstResponseMinutes: 90,
      nextResponseMinutes: null,
      resolutionMinutes: null,
      businessHoursOnly: true,
    });
    const sentAt = new Date(Date.now() - minutes(1));
    const asked = await seedMessage(db, desk.inbox, {
      subject: "Hours",
      fromAddress: "a@client.test",
      uid: 1,
      sentAt,
    });
    await delivered(desk, asked.threadId, asked.messageId);
    const due = new Date((await dueOf(asked.threadId, desk.anaCookie)).firstResponseDueAt!);
    // 90 staffed minutes at one hour a day always ends at 09:30 UTC, a day or two later.
    expect(due.toISOString().slice(11)).toBe("09:30:00.000Z");
    expect(due.getTime() - sentAt.getTime()).toBeGreaterThan(minutes(24 * 60));
  });

  test("the minute cron alerts at risk and breached once each, to the whole inbox while nobody owns it", async () => {
    const { db } = database;
    const desk = await slaDesk("sla-cron");
    await put(`/mailboxes/${desk.inbox.id}/sla/normal`, desk.anaCookie, {
      firstResponseMinutes: 5,
      nextResponseMinutes: null,
      resolutionMinutes: 30,
      businessHoursOnly: false,
    });
    const t0 = Date.now() - minutes(10);
    const late = await seedMessage(db, desk.inbox, {
      subject: "Late",
      fromAddress: "a@client.test",
      uid: 1,
      sentAt: new Date(t0),
    });
    await delivered(desk, late.threadId, late.messageId);
    // Snoozed: it alerts only once it is open again.
    const fine = await seedMessage(db, desk.inbox, {
      subject: "Fine",
      fromAddress: "b@client.test",
      uid: 2,
      sentAt: new Date(t0),
    });
    await delivered(desk, fine.threadId, fine.messageId);
    await post(`/threads/${fine.threadId}/snooze`, desk.anaCookie, {
      until: new Date(Date.now() + minutes(60)).toISOString(),
    });

    for (let run = 0; run < 2; run++) {
      const result = await worker.server.getWorker().scheduled({ cron: "* * * * *" });
      expect(result.outcome).toBe("ok");
    }

    const alerts = await db
      .select({
        threadId: schema.conversationEvents.threadId,
        kind: schema.conversationEvents.kind,
        data: schema.conversationEvents.data,
      })
      .from(schema.conversationEvents)
      .where(
        and(
          eq(schema.conversationEvents.mailboxId, desk.inbox.id),
          sql`${schema.conversationEvents.kind} in ('sla_at_risk', 'sla_breached')`,
        ),
      )
      .orderBy(schema.conversationEvents.kind);
    expect(alerts).toEqual([
      {
        threadId: late.threadId,
        kind: "sla_at_risk",
        data: { target: "resolution", dueAt: iso(t0 + minutes(30)) },
      },
      {
        threadId: late.threadId,
        kind: "sla_breached",
        data: { target: "first_response", dueAt: iso(t0 + minutes(5)) },
      },
    ]);
    const notified = await db
      .select({ memberId: schema.notifications.memberId, kind: schema.notifications.kind })
      .from(schema.notifications)
      .where(eq(schema.notifications.threadId, late.threadId))
      .orderBy(schema.notifications.kind, schema.notifications.memberId);
    expect(notified).toEqual(
      [
        { memberId: desk.ana.id, kind: "sla_at_risk" },
        { memberId: desk.bea.id, kind: "sla_at_risk" },
        { memberId: desk.ana.id, kind: "sla_breached" },
        { memberId: desk.bea.id, kind: "sla_breached" },
      ].sort((a, b) => a.kind.localeCompare(b.kind) || a.memberId.localeCompare(b.memberId)),
    );
    // It shows in the SLA at risk view.
    const view = await api(
      `/conversations?mailboxId=${desk.inbox.id}&view=sla_at_risk`,
      desk.anaCookie,
    );
    expect(
      ((await view.json()) as { conversations: { id: string }[] }).conversations.map((c) => c.id),
    ).toEqual([late.threadId]);
  });
});

describe("bulk actions and auto-assign", () => {
  let desk: Awaited<ReturnType<typeof supportDesk>>;
  let beaCookie: string;
  beforeAll(async () => {
    desk = await supportDesk("bulk");
    beaCookie = await signIn(worker, database.db, "bea@bulk.test");
    await database.db
      .update(schema.members)
      .set({ role: "admin" })
      .where(eq(schema.members.id, desk.ana.id));
  });

  const bulk = (body: unknown, key = `bulk-${randomUUID()}`) =>
    api("/conversations/bulk", desk.anaCookie, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "idempotency-key": key },
    });

  test("a bulk change applies to each conversation on its own, and a retry undoes nothing done since", async () => {
    const { db } = database;
    const [a, b] = await Promise.all(
      [1, 2].map((uid) =>
        seedMessage(db, desk.inbox, { subject: `Bulk ${uid}`, fromAddress: "c@client.test", uid }),
      ),
    );
    // A conversation in an inbox Ana cannot see: that one fails, the others still apply.
    const other = await createMailbox(db, desk.org.id, "billing@bulk.test");
    const hidden = await seedMessage(db, other, {
      subject: "Hidden",
      fromAddress: "c@client.test",
      uid: 1,
    });

    const key = `bulk-${randomUUID()}`;
    const ids = [a!.threadId, hidden.threadId, b!.threadId];
    const first = await bulk({ threadIds: ids, change: { type: "resolve" } }, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      results: [
        { threadId: a!.threadId, ok: true, changed: true },
        { threadId: hidden.threadId, ok: false, error: "not found" },
        { threadId: b!.threadId, ok: true, changed: true },
      ],
    });
    // Each resolve files its mail once.
    expect((await queued(db, desk.inbox.id)).filter((x) => x.kind === "archive")).toHaveLength(2);

    // Bea reopens one; Ana's client retries the same request: Bea's reopen stands.
    await post(`/threads/${b!.threadId}/reopen`, beaCookie);
    const retry = await bulk({ threadIds: ids, change: { type: "resolve" } }, key);
    expect(((await retry.json()) as { results: { changed?: boolean }[] }).results[2]).toEqual({
      threadId: b!.threadId,
      ok: true,
      changed: false,
    });
    expect((await conversation(b!.threadId, desk.anaCookie)).status).toBe("open");

    // Claim assigns each to the member asking.
    await bulk({ threadIds: [a!.threadId, b!.threadId], change: { type: "claim" } });
    for (const id of [a!.threadId, b!.threadId]) {
      expect((await conversation(id, desk.anaCookie)).assigneeMemberId).toBe(desk.ana.id);
    }
    expect((await bulk({ threadIds: [], change: { type: "resolve" } })).status).toBe(400);
  });

  test("two teammates bulk-claiming overlapping unassigned conversations never take one from the other", async () => {
    const { db } = database;
    const [a, b, c] = await Promise.all(
      [11, 12, 13].map((uid) =>
        seedMessage(db, desk.inbox, { subject: `Race ${uid}`, fromAddress: "c@client.test", uid }),
      ),
    );
    const claim = (cookie: string, threadIds: string[]) =>
      api("/conversations/bulk", cookie, {
        method: "POST",
        body: JSON.stringify({ threadIds, change: { type: "claim", expectedAssignee: null } }),
      });
    // Both selected everything unassigned; their selections overlap on b.
    const [ana, bea] = await Promise.all([
      claim(desk.anaCookie, [a!.threadId, b!.threadId]),
      claim(beaCookie, [b!.threadId, c!.threadId]),
    ]);
    type Results = { results: { threadId: string; ok: boolean; error?: string }[] };
    const results = [
      ...((await ana.json()) as Results).results,
      ...((await bea.json()) as Results).results,
    ];
    const forB = results.filter((r) => r.threadId === b!.threadId);
    expect(forB.map((r) => r.ok).toSorted()).toEqual([false, true]);
    expect(forB.find((r) => !r.ok)?.error).toBe("a teammate assigned this conversation first");
    expect((await conversation(a!.threadId, desk.anaCookie)).assigneeMemberId).toBe(desk.ana.id);
    expect((await conversation(c!.threadId, desk.anaCookie)).assigneeMemberId).toBe(desk.bea.id);
    const events = (await conversation(b!.threadId, desk.anaCookie)).events;
    expect(events.filter((e) => e.kind === "assigned")).toHaveLength(1);
  });

  test("auto-assign hands new conversations out in turn, never history or auto-replies", async () => {
    const { db } = database;
    const inbox = await createMailbox(db, desk.org.id, "help@bulk.test");
    await grant(db, desk.org.id, inbox.id, desk.ana.id);
    await grant(db, desk.org.id, inbox.id, desk.bea.id);
    await db
      .update(schema.mailboxes)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(schema.mailboxes.id, inbox.id));
    const turnOn = await put(`/mailboxes/${inbox.id}/auto-assign`, desk.anaCookie, {
      enabled: true,
    });
    expect(turnOn.status).toBe(200);
    expect(
      (
        (await (await api(`/mailboxes/${inbox.id}/sla`, desk.anaCookie)).json()) as {
          autoAssign: boolean;
        }
      ).autoAssign,
    ).toBe(true);

    const deliver = async (n: number, options: { sentAt?: Date; automated?: boolean } = {}) => {
      const message = await seedMessage(db, inbox, {
        subject: `Help ${n}`,
        fromAddress: `c${n}@client.test`,
        uid: n,
        sentAt: options.sentAt,
      });
      if (options.automated) {
        await db
          .update(schema.messages)
          .set({ automated: true })
          .where(eq(schema.messages.id, message.messageId));
      }
      const response = await postMailEvents(worker, {
        events: [
          {
            type: "message.created",
            orgId: desk.org.id,
            mailboxId: inbox.id,
            threadId: message.threadId,
            messageId: message.messageId,
            folderRole: "inbox",
          },
        ],
      });
      expect(response.status).toBe(202);
      return (await conversation(message.threadId, desk.anaCookie)).assigneeMemberId;
    };

    const [first, second] = [desk.ana.id, desk.bea.id].sort();
    expect([await deliver(1), await deliver(2), await deliver(3)]).toEqual([first, second, first]);
    // History from before the inbox was connected, and an out-of-office, stay unassigned.
    expect(await deliver(4, { sentAt: new Date(Date.now() - 2 * 60 * 60_000) })).toBeNull();
    expect(await deliver(5, { automated: true })).toBeNull();

    // The member it went to hears "assigned", not also "your customer replied".
    const kinds = await db
      .select({ kind: schema.notifications.kind })
      .from(schema.notifications)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.notifications.threadId))
      .where(eq(schema.threads.mailboxId, inbox.id));
    expect(kinds.map((k) => k.kind)).toEqual(["assigned", "assigned", "assigned"]);

    // Only owners and admins switch it.
    expect(
      (await put(`/mailboxes/${inbox.id}/auto-assign`, beaCookie, { enabled: false })).status,
    ).toBe(403);
  });
  test("the inbox report counts new conversations and times first responses and resolutions", async () => {
    const { db } = database;
    const inbox = await createMailbox(db, desk.org.id, "report@bulk.test");
    await grant(db, desk.org.id, inbox.id, desk.ana.id);
    await grant(db, desk.org.id, inbox.id, desk.bea.id);
    const t0 = Date.now() - 5 * 3_600_000;
    const at = (minutes: number) => new Date(t0 + minutes * 60_000);
    let uid = 0;
    const deliver = async (
      from: string,
      sentAt: Date,
      threadId?: string,
      folder: "INBOX" | "Sent" = "INBOX",
    ) => {
      const message = await seedMessage(db, inbox, {
        subject: "Report",
        fromAddress: from,
        uid: ++uid,
        sentAt,
        threadId,
        folder,
      });
      await postMailEvents(worker, {
        events: [
          {
            type: "message.created",
            orgId: desk.org.id,
            mailboxId: inbox.id,
            threadId: message.threadId,
            messageId: message.messageId,
            folderRole: folder === "Sent" ? "sent" : "inbox",
          },
        ],
      });
      return message.threadId;
    };
    // Answered in 10 minutes, then resolved; answered in 30; never answered, tagged, Bea's.
    const c1 = await deliver("a@client.test", at(0));
    await deliver(inbox.address, at(10), c1, "Sent");
    const c2 = await deliver("b@client.test", at(60));
    await deliver(inbox.address, at(90), c2, "Sent");
    const c3 = await deliver("c@client.test", at(120));
    // A conversation that started 40 days ago is not new this week, though it has new mail.
    const old = await deliver("d@client.test", new Date(Date.now() - 40 * 86_400_000));
    await deliver("d@client.test", at(180), old);
    // Its first reply, indexed only now, belongs to 40 days ago, not to this report.
    await deliver(inbox.address, new Date(Date.now() - 40 * 86_400_000 + 300_000), old, "Sent");

    const tag = (await (
      await post(`/mailboxes/${inbox.id}/tags`, desk.anaCookie, { name: "Billing" })
    ).json()) as { tag: { id: string } };
    await post(`/threads/${c3}/tags`, desk.anaCookie, { tagId: tag.tag.id });
    await put(`/threads/${c3}/assignee`, desk.anaCookie, { memberId: desk.bea.id });
    await post(`/threads/${c1}/resolve`, desk.anaCookie);
    // Mail we sent first, from an alias, then resolved: not a new conversation, no timing sample.
    const outbound = await deliver("sales@alias.test", at(200), undefined, "Sent");
    await post(`/threads/${outbound}/resolve`, desk.anaCookie);

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const response = await api(
      `/mailboxes/${inbox.id}/report?from=${encodeURIComponent(from)}`,
      desk.anaCookie,
    );
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      created: unknown;
      firstResponse: unknown;
      resolved: { count: number; median: number; p90: number; byMember: unknown };
    };
    expect(report.created).toEqual({
      count: 3,
      byAssignee: [
        { memberId: null, count: 2 },
        { memberId: desk.bea.id, count: 1 },
      ],
      byTag: [{ tagId: tag.tag.id, count: 1 }],
    });
    // 600 s and 1800 s: median 1200, p90 interpolated to 1680.
    expect(report.firstResponse).toEqual({ count: 2, median: 1200, p90: 1680 });
    expect(report.resolved.count).toBe(1);
    expect(report.resolved.byMember).toEqual([{ memberId: desk.ana.id, count: 2 }]);
    // Resolved just now, five hours after the customer wrote.
    expect(Math.abs(report.resolved.median - 5 * 3600)).toBeLessThan(120);

    expect(
      (
        await api(
          `/mailboxes/${inbox.id}/report?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`,
          desk.anaCookie,
        )
      ).status,
    ).toBe(400);
  });
});
