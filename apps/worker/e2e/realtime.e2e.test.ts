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
async function connect(cookie: string) {
  const url = new URL("/api/realtime", worker.url);
  url.protocol = "ws:";
  // Node's WebSocket (undici) accepts headers, which carry the session cookie here.
  const socket = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
  const received: { type: string; mailboxId: string; threadIds: string[] }[] = [];
  socket.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  return {
    socket,
    received,
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
