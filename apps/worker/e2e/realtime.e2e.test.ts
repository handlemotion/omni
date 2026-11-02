import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  openRealtime,
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

const connect = (cookie: string) => openRealtime(worker, cookie);

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

  expect(await beaSocket.next(1)).toEqual([
    { type: "changed", mailboxId: beaBox.id, threadIds: [beaThread.threadId] },
  ]);
  expect(await anaSocket.next(1)).toEqual([
    { type: "changed", mailboxId: anaBox.id, threadIds: [anaThread.threadId] },
  ]);
  // Ana's event went out before Bea's, so had it leaked Bea would have seen it first.
  expect(beaSocket.received).toHaveLength(1);
  expect(anaSocket.received).toHaveLength(1);

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
