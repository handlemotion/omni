// The web app in a real Chromium, built and served by the real Worker under `wrangler dev`,
// on a real Postgres; sends go out through the real mail service outbox to GreenMail. Nothing is
// mocked: the Worker really stops and starts, the browser really goes offline, and the one fault
// injected is a response lost on the wire after the Worker has handled the request.
import { createServer } from "node:net";
import { schema } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { MailboxConnection } from "../../mail/src/mailbox-connection.ts";
import { OutboxExecutor } from "../../mail/src/outbox.ts";
import { PgActionSource, PgMailStore } from "../../mail/src/pg-store.ts";
import { deliver, logger, mailbox, otherClient } from "../../mail/e2e/support/greenmail.ts";
import { createTestBucket, links } from "../../mail/e2e/support/objects.ts";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>> | undefined;
let browser: Browser;
let context: BrowserContext | undefined;
let connections: MailboxConnection[] = [];
let port: number;
let origin: string;

/** The Worker on a fixed port, so a restart comes back where the open page expects it. */
async function startApp() {
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: origin },
  });
}

async function stopApp() {
  await worker?.close();
  worker = undefined;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  await startApp();
  // Playwright's own Chromium where it is installed; otherwise the machine's Chrome (CI runners).
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await stopApp();
  await mailService?.close();
  await database?.teardown();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
  await Promise.all(connections.map((c) => c.stop()));
  connections = [];
});

/** A member signed in, with the app open on `path`. */
async function openApp(email: string, path: string): Promise<{ page: Page; tab: BrowserContext }> {
  if (!worker) throw new Error("the Worker is not running");
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const tab = await browser.newContext();
  context = tab;
  await tab.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await tab.newPage();
  await page.goto(new URL(path, origin).toString());
  return { page, tab };
}

test(
  "after the Worker restarts the app reconnects by itself and shows what it missed",
  { timeout: 90_000 },
  async () => {
    const org = await createOrg(db, "restart");
    await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
    const ana = await createMember(db, org.id, "ana@restart.test");
    const box = await createMailbox(db, org.id, "ana@restart.test", "personal");
    await grant(db, org.id, box.id, ana.id);
    const first = await seedMessage(db, box, {
      subject: "Status",
      fromAddress: "pm@client.test",
      uid: 1,
      text: "Before the restart.",
    });

    const { page } = await openApp("ana@restart.test", `/inbox/${first.threadId}`);
    const sockets: { closed: boolean }[] = [];
    page.on("websocket", (ws) => {
      const socket = { closed: false };
      sockets.push(socket);
      ws.on("close", () => (socket.closed = true));
    });
    const open = () => sockets.filter((s) => !s.closed).length;
    await page.locator("article").getByText("Before the restart.").waitFor();
    await expect.poll(open).toBe(1);

    await stopApp();
    await expect.poll(open).toBe(0);
    // Mail arrives while the Worker is down: no event will ever announce it.
    await seedMessage(db, box, {
      subject: "Re: Status",
      fromAddress: "pm@client.test",
      uid: 2,
      threadId: first.threadId,
      text: "Sent while you were away.",
    });
    await startApp();

    // No reload: the socket comes back on its own and the thread on screen is refetched. The wait
    // covers the Worker's own rebuild and boot plus the socket's backoff, capped at 30 seconds.
    await page
      .locator("article")
      .getByText("Sent while you were away.")
      .waitFor({ timeout: 45_000 });
    expect(open()).toBe(1);
  },
);

test("replies written offline go out once each, in order, when the connection is back", async () => {
  const org = await createOrg(db, "offline");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@offline.test");
  // A real GreenMail mailbox, synced by the real mail service.
  const box = { ...mailbox(), orgId: org.id };
  await db.insert(schema.mailboxes).values({
    id: box.id,
    orgId: org.id,
    address: box.address,
    kind: "personal",
    credentialsEnc: "unused-by-direct-connections",
    status: "active",
  });
  await grant(db, org.id, box.id, ana.id);
  const { objects } = await createTestBucket();
  const connection = new MailboxConnection(box, {
    store: new PgMailStore({ db, objects, links }),
    logger,
  });
  connections.push(connection);
  await connection.start();
  const arrived = new Promise((resolve) => connection.once("message", resolve));
  await deliver(box.address, "Plans");
  await arrived;
  const [thread] = await db
    .select({ id: schema.threads.id })
    .from(schema.threads)
    .where(eq(schema.threads.mailboxId, box.id));
  if (!thread) throw new Error("the delivered message was not indexed");

  const { page, tab } = await openApp("ana@offline.test", `/inbox/${thread.id}`);
  await page.locator("article").getByText("body of Plans").waitFor();

  // The Worker handles the first reply that reaches it, but its answer never gets back.
  let replyRequests = 0;
  await page.route("**/api/threads/*/reply", async (route) => {
    replyRequests++;
    if (replyRequests > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });

  await tab.setOffline(true);
  await page.getByRole("status").filter({ hasText: "Offline" }).waitFor();
  const reply = async (text: string) => {
    await page.locator("textarea").fill(text);
    await page.getByRole("button", { name: "Reply" }).click();
  };
  await reply("First, offline.");
  await reply("Second, offline.");
  await page.getByRole("status").filter({ hasText: "Offline · 2 queued" }).waitFor();
  // Both show in the thread right away, and nothing has left the browser.
  await page.locator("article").getByText("First, offline.").waitFor();
  await page.locator("article").getByText("Second, offline.").waitFor();
  expect(replyRequests).toBe(0);

  await tab.setOffline(false);

  const sends = () =>
    db
      .select({
        payload: schema.mailActions.payload,
        idempotencyKey: schema.mailActions.idempotencyKey,
      })
      .from(schema.mailActions)
      .where(and(eq(schema.mailActions.memberId, ana.id), eq(schema.mailActions.kind, "send")))
      .orderBy(asc(schema.mailActions.createdAt), asc(schema.mailActions.id));
  await expect.poll(async () => (await sends()).length, { timeout: 30_000 }).toBe(2);
  await page
    .getByRole("status")
    .filter({ hasText: "Offline" })
    .waitFor({ state: "detached", timeout: 30_000 });
  // The first reply was sent again after its answer was lost, under the same key.
  expect(replyRequests).toBe(3);
  const queued = await sends();
  expect(queued.map((row) => (row.payload as { text: string }).text)).toEqual([
    "First, offline.",
    "Second, offline.",
  ]);
  await expect.poll(() => page.locator("article").getByText("(queued)").count()).toBe(2);

  // The mail service's outbox sends them: the sender of "Plans" gets each reply once.
  const actions = new PgActionSource({ db });
  const executor = new OutboxExecutor({
    actions,
    logger,
    connection: (id) => (id === box.id ? connection : undefined),
  });
  for (let claimed = await actions.claim(10); claimed.length; claimed = await actions.claim(10)) {
    for (const action of claimed) await executor.execute(action);
  }
  const ids = queued.map((row) => (row.payload as { messageId: string }).messageId);
  const received = await otherClient({ ...box, user: "sender@outside.test" }, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await Promise.all(
        ids.map(
          async (id) =>
            (await client.search({ header: { "message-id": id } }, { uid: true })) || [],
        ),
      );
    } finally {
      lock.release();
    }
  });
  expect(received.map((uids) => uids.length)).toEqual([1, 1]);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: free } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return free;
}
