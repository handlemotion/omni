import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  pushFrame,
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
  WEB_ORIGIN,
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

function handshake(cookie: string, origin?: string) {
  const url = new URL("/api/realtime", worker.url);
  return new Promise<number>((resolve, reject) => {
    const req = request(url, {
      headers: {
        cookie,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...(origin ? { origin } : {}),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function connect(cookie: string, query: Record<string, string> = {}) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.addEventListener("message", (e) => {
    pushFrame(received, e.data);
    for (const waiter of waiters) waiter();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
    presence(threadId: string, state: "viewing" | "replying" | "left") {
      socket.send(JSON.stringify({ type: "presence", threadId, state }));
    },
    async next(count: number) {
      const enough = Promise.withResolvers<void>();
      const check = () => received.length >= count && enough.resolve();
      waiters.add(check);
      check();
      await enough.promise.finally(() => waiters.delete(check));
      return received;
    },
  };
}

test("mail events reach only members who can see the mailbox, also after hibernation", async () => {
  const { db } = database;
  const org = await createOrg(db, "acme");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@acme.test");
  const bea = await createMember(db, org.id, "bea@acme.test");
  const anaBox = await createMailbox(db, org.id, "ana@acme.test", "personal");
  const beaBox = await createMailbox(db, org.id, "bea@acme.test", "personal");
  await grant(db, org.id, anaBox.id, ana.id);
  await grant(db, org.id, beaBox.id, bea.id);
  const anaThread = await seedMessage(db, anaBox, {
    subject: "For Ana",
    fromAddress: "x@client.test",
    uid: 1,
  });
  const beaThread = await seedMessage(db, beaBox, {
    subject: "For Bea",
    fromAddress: "y@client.test",
    uid: 1,
  });

  await expect(connect("")).rejects.toThrow("websocket failed to open");

  const anaSocket = await connect(await signIn(worker, db, "ana@acme.test"));
  const beaSocket = await connect(await signIn(worker, db, "bea@acme.test"));

  const event = (mailbox: { id: string }, thread: { threadId: string; messageId: string }) => ({
    events: [
      {
        type: "message.created" as const,
        folderRole: "inbox" as const,
        orgId: org.id,
        mailboxId: mailbox.id,
        threadId: thread.threadId,
        messageId: thread.messageId,
      },
    ],
  });

  expect((await postMailEvents(worker, event(anaBox, anaThread))).status).toBe(202);
  await worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: org.id, webSockets: "hibernate" });
  expect((await postMailEvents(worker, event(beaBox, beaThread))).status).toBe(202);

  const changed = (mailboxId: string, threadId: string) => [
    { type: "changed", mailboxId, threadIds: [threadId] },
    { type: "thread.changed", mailboxId, threadIds: [threadId] },
  ];
  expect(await beaSocket.next(2)).toEqual(changed(beaBox.id, beaThread.threadId));
  expect(await anaSocket.next(2)).toEqual(changed(anaBox.id, anaThread.threadId));
  expect(beaSocket.received).toHaveLength(2);
  expect(anaSocket.received).toHaveLength(2);

  anaSocket.socket.close();
  beaSocket.socket.close();
});

test("a send that failed for good is told to the member who sent it, and nobody else", async () => {
  const { db } = database;
  const org = await createOrg(db, "globex");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@globex.test");
  const bea = await createMember(db, org.id, "bea@globex.test");
  const box = await createMailbox(db, org.id, "team@globex.test");
  await grant(db, org.id, box.id, ana.id);
  await grant(db, org.id, box.id, bea.id);

  const anaSocket = await connect(await signIn(worker, db, "ana@globex.test"));
  const beaSocket = await connect(await signIn(worker, db, "bea@globex.test"));
  const failed = (actionId: string, memberId: string | null) => ({
    events: [
      {
        type: "action.failed" as const,
        orgId: org.id,
        mailboxId: box.id,
        actionId,
        memberId,
        error: "550 mailbox unavailable",
      },
    ],
  });
  expect((await postMailEvents(worker, failed("system-action", null))).status).toBe(202);
  expect((await postMailEvents(worker, failed("ana-send", ana.id))).status).toBe(202);

  expect(await anaSocket.next(1)).toEqual([
    { type: "action", actionId: "ana-send", status: "failed", error: "550 mailbox unavailable" },
  ]);
  expect((await postMailEvents(worker, failed("bea-send", bea.id))).status).toBe(202);
  expect(await beaSocket.next(1)).toEqual([
    { type: "action", actionId: "bea-send", status: "failed", error: "550 mailbox unavailable" },
  ]);
  expect(beaSocket.received).toHaveLength(1);

  anaSocket.socket.close();
  beaSocket.socket.close();
});

test("mail deleted on the server refreshes its threads for open apps and re-runs their AI", async () => {
  const { db } = database;
  const org = await createOrg(db, "initech");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@initech.test");
  const box = await createMailbox(db, org.id, "help@initech.test");
  await grant(db, org.id, box.id, ana.id);
  const kept = await seedMessage(db, box, { subject: "Kept", fromAddress: "x@c.test", uid: 1 });
  const anaSocket = await connect(await signIn(worker, db, "ana@initech.test"));

  const gone = Array.from({ length: 149 }, (_, i) => `deleted-thread-${i}`);
  const response = await postMailEvents(worker, {
    events: [
      {
        type: "messages.pruned",
        orgId: org.id,
        mailboxId: box.id,
        threadIds: [kept.threadId, ...gone],
      },
    ],
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, jobs: 150 });
  const threadIds = [kept.threadId, ...gone];
  expect(await anaSocket.next(2)).toEqual([
    { type: "changed", mailboxId: box.id, threadIds },
    { type: "thread.changed", mailboxId: box.id, threadIds },
  ]);
  anaSocket.socket.close();
});

test("a thread read or archived in another mail app refreshes open apps without AI", async () => {
  const { db } = database;
  const org = await createOrg(db, "umbrella");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@umbrella.test");
  const box = await createMailbox(db, org.id, "help@umbrella.test");
  await grant(db, org.id, box.id, ana.id);
  const thread = await seedMessage(db, box, { subject: "Read", fromAddress: "x@c.test", uid: 1 });
  const anaSocket = await connect(await signIn(worker, db, "ana@umbrella.test"));

  const response = await postMailEvents(worker, {
    events: [
      { type: "threads.changed", orgId: org.id, mailboxId: box.id, threadIds: [thread.threadId] },
    ],
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, jobs: 0 });
  const threadIds = [thread.threadId];
  expect(await anaSocket.next(2)).toEqual([
    { type: "changed", mailboxId: box.id, threadIds },
    { type: "thread.changed", mailboxId: box.id, threadIds },
  ]);
  anaSocket.socket.close();
});

test("a thread archived or trashed in Omni refreshes teammates' open apps", async () => {
  const { db } = database;
  const org = await createOrg(db, "shelf");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@shelf.test");
  const bea = await createMember(db, org.id, "bea@shelf.test");
  const box = await createMailbox(db, org.id, "help@shelf.test");
  await grant(db, org.id, box.id, ana.id);
  await grant(db, org.id, box.id, bea.id);
  const archived = await seedMessage(db, box, { subject: "Done", fromAddress: "x@c.test", uid: 1 });
  const trashed = await seedMessage(db, box, { subject: "Junk", fromAddress: "y@c.test", uid: 2 });
  const anaCookie = await signIn(worker, db, "ana@shelf.test");
  const beaSocket = await connect(await signIn(worker, db, "bea@shelf.test"));
  const post = (path: string) =>
    fetch(new URL(`/api${path}`, worker.url), {
      method: "POST",
      headers: { cookie: anaCookie, "idempotency-key": `key-${randomBytes(8).toString("hex")}` },
    });

  expect((await post(`/threads/${archived.threadId}/archive`)).status).toBe(200);
  expect((await post(`/threads/${trashed.threadId}/trash`)).status).toBe(200);

  const heard = await beaSocket.next(4);
  expect(heard).toHaveLength(4);
  expect(heard).toEqual(
    expect.arrayContaining([
      { type: "changed", mailboxId: box.id, threadIds: [archived.threadId] },
      { type: "thread.changed", mailboxId: box.id, threadIds: [archived.threadId] },
      { type: "changed", mailboxId: box.id, threadIds: [trashed.threadId] },
      { type: "thread.changed", mailboxId: box.id, threadIds: [trashed.threadId] },
    ]),
  );
  beaSocket.socket.close();
});

test("merged threads refresh both ids, tell readers where to go and re-summarize the survivor", async () => {
  const { db } = database;
  const org = await createOrg(db, "hooli");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@hooli.test");
  const box = await createMailbox(db, org.id, "help@hooli.test");
  await grant(db, org.id, box.id, ana.id);
  const kept = await seedMessage(db, box, { subject: "Refund", fromAddress: "x@c.test", uid: 1 });
  const anaSocket = await connect(await signIn(worker, db, "ana@hooli.test"));

  const response = await postMailEvents(worker, {
    events: [
      {
        type: "threads.merged",
        orgId: org.id,
        mailboxId: box.id,
        intoThreadId: kept.threadId,
        fromThreadIds: ["merged-thread"],
      },
    ],
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, jobs: 1 });
  const threadIds = [kept.threadId, "merged-thread"];
  expect(await anaSocket.next(3)).toEqual([
    { type: "changed", mailboxId: box.id, threadIds },
    { type: "thread.changed", mailboxId: box.id, threadIds },
    {
      type: "merged",
      mailboxId: box.id,
      intoThreadId: kept.threadId,
      fromThreadIds: ["merged-thread"],
    },
  ]);
  anaSocket.socket.close();
});

test("a page on a foreign origin cannot open the member's socket with their cookie", async () => {
  const { db } = database;
  const org = await createOrg(db, "origins");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  await createMember(db, org.id, "ana@origins.test");
  const cookie = await signIn(worker, db, "ana@origins.test");

  expect(await handshake(cookie, "https://evil.example")).toBe(403);
  expect(await handshake(cookie, "null")).toBe(403);
  expect(await handshake(cookie, WEB_ORIGIN)).toBe(101);
  expect(await handshake(cookie)).toBe(101);
});

async function supportDesk(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const inbox = await createMailbox(db, org.id, `support@${slug}.test`);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  const carl = await createMember(db, org.id, `carl@${slug}.test`);
  await grant(db, org.id, inbox.id, ana.id);
  await grant(db, org.id, inbox.id, bea.id);
  const { threadId } = await seedMessage(db, inbox, {
    subject: "Broken export",
    fromAddress: "luis@client.test",
    uid: 1,
  });
  return { org, inbox, ana, bea, carl, threadId };
}

test("presence reaches only teammates who can see the conversation, survives hibernation, and clears on close", async () => {
  const { db } = database;
  const desk = await supportDesk("presence");
  const ana = await connect(await signIn(worker, db, "ana@presence.test"));
  const bea = await connect(await signIn(worker, db, "bea@presence.test"));
  const carl = await connect(await signIn(worker, db, "carl@presence.test"));
  const at = (memberId: string, state: string) => ({
    type: "presence",
    mailboxId: desk.inbox.id,
    threadId: desk.threadId,
    memberId,
    state,
  });

  ana.presence(desk.threadId, "viewing");
  expect(await bea.next(1)).toEqual([at(desk.ana.id, "viewing")]);
  await worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: desk.org.id, webSockets: "hibernate" });
  bea.presence(desk.threadId, "replying");
  expect(await bea.next(2)).toEqual([at(desk.ana.id, "viewing"), at(desk.ana.id, "viewing")]);
  expect(await ana.next(1)).toEqual([at(desk.bea.id, "replying")]);

  carl.presence(desk.threadId, "viewing");
  ana.presence(desk.threadId, "x".repeat(2000) as "viewing");
  ana.socket.send("not json");
  ana.presence(desk.threadId, "replying");
  expect(await bea.next(3)).toEqual([
    at(desk.ana.id, "viewing"),
    at(desk.ana.id, "viewing"),
    at(desk.ana.id, "replying"),
  ]);
  expect(ana.received).toHaveLength(1);

  ana.socket.close();
  expect(await bea.next(4)).toEqual([
    at(desk.ana.id, "viewing"),
    at(desk.ana.id, "viewing"),
    at(desk.ana.id, "replying"),
    at(desk.ana.id, "left"),
  ]);
  expect(carl.received).toEqual([]);
  bea.socket.close();
  carl.socket.close();
});

test("a repeated heartbeat refreshes teammates, and a second tab viewing never hides one replying", async () => {
  const { db } = database;
  const desk = await supportDesk("heartbeat");
  const anaCookie = await signIn(worker, db, "ana@heartbeat.test");
  const replyingTab = await connect(anaCookie);
  const viewingTab = await connect(anaCookie);
  const bea = await connect(await signIn(worker, db, "bea@heartbeat.test"));
  const ana = (state: string) => ({
    type: "presence",
    mailboxId: desk.inbox.id,
    threadId: desk.threadId,
    memberId: desk.ana.id,
    state,
  });

  replyingTab.presence(desk.threadId, "replying");
  expect(await bea.next(1)).toEqual([ana("replying")]);
  replyingTab.presence(desk.threadId, "replying");
  expect(await bea.next(2)).toEqual([ana("replying"), ana("replying")]);
  viewingTab.presence(desk.threadId, "viewing");
  expect(await bea.next(3)).toEqual([ana("replying"), ana("replying"), ana("replying")]);
  for (const socket of [replyingTab, viewingTab, bea]) socket.socket.close();
});

test("notes and assignments notify teammates live, as their preferences allow", async () => {
  const { db } = database;
  const desk = await supportDesk("live");
  const anaCookie = await signIn(worker, db, "ana@live.test");
  const bea = await connect(await signIn(worker, db, "bea@live.test"));
  const carl = await connect(await signIn(worker, db, "carl@live.test"));
  await db.insert(schema.memberPreferences).values({
    orgId: desk.org.id,
    memberId: desk.bea.id,
    notifications: { mention: { realtime: false, desktop: true, push: true } },
  });
  const api = (path: string, method: string, body: unknown) =>
    fetch(new URL(`/api${path}`, worker.url), {
      method,
      headers: {
        cookie: anaCookie,
        "content-type": "application/json",
        "idempotency-key": `key-${randomBytes(8).toString("hex")}`,
      },
      body: JSON.stringify(body),
    });

  const created = await api(`/threads/${desk.threadId}/notes`, "POST", {
    body: "@Bea can you look?",
    mentions: [desk.bea.id],
  });
  expect(created.status).toBe(201);
  const { note } = (await created.json()) as { note: { id: string } };
  expect(
    (await api(`/threads/${desk.threadId}/assignee`, "PUT", { memberId: desk.bea.id })).status,
  ).toBe(200);

  expect(
    (await api(`/threads/${desk.threadId}/notes/${note.id}`, "PATCH", { body: "@Bea please" }))
      .status,
  ).toBe(200);

  await bea.next(8);
  const anaSocket = await connect(anaCookie);
  anaSocket.presence(desk.threadId, "viewing");
  await bea.next(9);
  expect(bea.received.at(-1)).toMatchObject({ type: "presence", memberId: desk.ana.id });
  const helpdesk = bea.received
    .filter((e) => !["changed", "thread.changed", "presence"].includes(String(e.type)))
    .sort((a, b) => String(a.type).localeCompare(String(b.type)));
  expect(helpdesk).toEqual([
    { type: "note.created", mailboxId: desk.inbox.id, threadId: desk.threadId, noteId: note.id },
    { type: "notification", threadId: desk.threadId, kind: "assigned" },
  ]);
  expect(bea.received.filter((e) => e.type === "thread.changed")).toHaveLength(3);
  expect(carl.received).toEqual([]);

  const mentionsOf = () =>
    db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(eq(schema.notifications.noteId, note.id));
  expect(await mentionsOf()).toHaveLength(1);
  const seen = bea.received.length;
  expect(
    (await api(`/threads/${desk.threadId}/notes/${note.id}`, "DELETE", undefined)).status,
  ).toBe(204);
  await bea.next(seen + 3);
  anaSocket.presence(desk.threadId, "left");
  await bea.next(seen + 4);
  expect(bea.received.at(-1)).toMatchObject({ type: "presence", state: "left" });
  expect(bea.received.slice(seen).filter((e) => e.type === "notification.removed")).toEqual([
    { type: "notification.removed", threadId: desk.threadId },
  ]);
  expect(await mentionsOf()).toEqual([]);
  anaSocket.socket.close();
  bea.socket.close();
  carl.socket.close();
});

test("a watch socket hears new mail once, never backlog or its own sends, and leaves the app socket alone", async () => {
  const { db } = database;
  const org = await createOrg(db, "watchers");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@watchers.test");
  const box = await createMailbox(db, org.id, "ana@watchers.test", "personal");
  await grant(db, org.id, box.id, ana.id);
  const fresh = await seedMessage(db, box, {
    subject: "Lunch?",
    fromAddress: "bea@client.test",
    uid: 1,
  });
  const old = await seedMessage(db, box, {
    subject: "Last week",
    fromAddress: "cal@client.test",
    uid: 2,
    sentAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });
  const own = await seedMessage(db, box, {
    subject: "Note to self",
    fromAddress: "ana@watchers.test",
    uid: 3,
  });

  const cookie = await signIn(worker, db, "ana@watchers.test");
  const app = await connect(cookie);
  const watch = await connect(cookie, { org: org.id, watch: "1" });
  const body = {
    events: [fresh, old, own].map((m) => ({
      type: "message.created" as const,
      folderRole: "inbox" as const,
      orgId: org.id,
      mailboxId: box.id,
      threadId: m.threadId,
      messageId: m.messageId,
    })),
  };
  expect((await postMailEvents(worker, body)).status).toBe(202);
  expect(await watch.next(1)).toEqual([
    { type: "mail.arrived", mailboxId: box.id, threadIds: [fresh.threadId] },
  ]);
  expect((await app.next(2)).map((e) => e.type)).toEqual(["changed", "thread.changed"]);

  expect((await postMailEvents(worker, body)).status).toBe(202);
  await app.next(4);
  expect(watch.received).toHaveLength(1);

  app.socket.close();
  watch.socket.close();
});
