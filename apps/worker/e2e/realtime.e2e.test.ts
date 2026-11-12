import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
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

/** Opens the realtime socket the way the apps do and collects what arrives. */
/** A raw websocket handshake, so the test can read the status a browser would hide. */
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

async function connect(cookie: string) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  // Node's WebSocket (undici) accepts headers: the session cookie, and the Origin a browser on
  // the web app would send.
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const received: Record<string, unknown>[] = [];
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
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
      const deadline = Date.now() + 10_000;
      while (received.length < count) {
        if (Date.now() > deadline)
          throw new Error(`expected ${count} events, got ${received.length}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
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

  // Without a session the upgrade is refused.
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
  // Sockets sleep between events; routing by tag must survive that.
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
  // Ana's event went out before Bea's, so had it leaked Bea would have seen it first.
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
  // System mail (no member) goes nowhere; the member's own send reaches only them.
  expect((await postMailEvents(worker, failed("system-action", null))).status).toBe(202);
  expect((await postMailEvents(worker, failed("ana-send", ana.id))).status).toBe(202);

  expect(await anaSocket.next(1)).toEqual([
    { type: "action", actionId: "ana-send", status: "failed", error: "550 mailbox unavailable" },
  ]);
  // Bea shares the mailbox, so a leak by mailbox audience would have reached her by now.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(beaSocket.received).toEqual([]);

  anaSocket.socket.close();
  beaSocket.socket.close();
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
  // Native clients send no Origin and hold the session themselves.
  expect(await handshake(cookie)).toBe(101);
});

/** A support inbox Ana and Bea work in, with Carl in the org but not in the inbox. */
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

const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

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
  // Ana's state is kept on her socket, not in memory: a hibernated object still knows it.
  await worker.server
    .getWorker()
    .evictDurableObject("Realtime", { name: desk.org.id, webSockets: "hibernate" });
  bea.presence(desk.threadId, "replying");
  // The newcomer hears who is already there; Ana hears Bea.
  expect(await bea.next(2)).toEqual([at(desk.ana.id, "viewing"), at(desk.ana.id, "viewing")]);
  expect(await ana.next(1)).toEqual([at(desk.bea.id, "replying")]);

  // Carl cannot see the inbox: his claim to be there is dropped, and he hears nothing.
  carl.presence(desk.threadId, "viewing");
  // Oversized and malformed messages are ignored.
  ana.presence(desk.threadId, "x".repeat(2000) as "viewing");
  ana.socket.send("not json");
  await quiet();
  expect(carl.received).toEqual([]);
  expect(ana.received).toHaveLength(1);
  expect(bea.received).toHaveLength(2);

  // Closing the app tells the others Ana left.
  ana.socket.close();
  expect(await bea.next(3)).toEqual([
    at(desk.ana.id, "viewing"),
    at(desk.ana.id, "viewing"),
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
  // The web app repeats its state every 30 s and drops a teammate unheard for 70 s.
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
  // Bea turned off live mention alerts, but not assignment alerts.
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

  // Editing the note refreshes it for teammates too.
  expect(
    (await api(`/threads/${desk.threadId}/notes/${note.id}`, "PATCH", { body: "@Bea please" }))
      .status,
  ).toBe(200);

  await bea.next(8);
  await quiet();
  // The two requests' fan-outs run after their responses, so they may interleave.
  const helpdesk = bea.received
    .filter((e) => e.type !== "changed" && e.type !== "thread.changed")
    .sort((a, b) => String(a.type).localeCompare(String(b.type)));
  expect(helpdesk).toEqual([
    { type: "note.created", mailboxId: desk.inbox.id, threadId: desk.threadId, noteId: note.id },
    { type: "notification", threadId: desk.threadId, kind: "assigned" },
  ]);
  expect(bea.received.filter((e) => e.type === "thread.changed")).toHaveLength(3);
  expect(carl.received).toEqual([]);

  // Deleting the note withdraws Bea's mention: gone from her list, and her app hears it live.
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
  await quiet();
  expect(bea.received.slice(seen).filter((e) => e.type === "notification.removed")).toEqual([
    { type: "notification.removed", threadId: desk.threadId },
  ]);
  expect(await mentionsOf()).toEqual([]);
  bea.socket.close();
  carl.socket.close();
});
