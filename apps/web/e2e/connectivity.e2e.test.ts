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

async function openApp(email: string, path: string) {
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
  return { page, tab } satisfies { page: Page; tab: BrowserContext };
}

test("after the Worker restarts the app reconnects by itself and shows what it missed", async () => {
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
  await seedMessage(db, box, {
    subject: "Re: Status",
    fromAddress: "pm@client.test",
    uid: 2,
    threadId: first.threadId,
    text: "Sent while you were away.",
  });
  await startApp();

  await page.locator("article").getByText("Sent while you were away.").waitFor({ timeout: 45_000 });
  expect(open()).toBe(1);
});

test("mail that arrives before the realtime socket first opens shows once it opens", async () => {
  const org = await createOrg(db, "late-socket");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@late-socket.test");
  const box = await createMailbox(db, org.id, "ana@late-socket.test", "personal");
  await grant(db, org.id, box.id, ana.id);
  const first = await seedMessage(db, box, {
    subject: "Kickoff",
    fromAddress: "pm@client.test",
    uid: 1,
    text: "Loaded before the socket.",
  });

  const { page, tab } = await openApp("ana@late-socket.test", "/");
  let refuse = true;
  let refused = 0;
  await tab.routeWebSocket("**/api/realtime*", (ws) => {
    if (!refuse) return ws.connectToServer();
    refused++;
    return ws.close({ code: 4000 });
  });
  await page.goto(new URL(`/inbox/${first.threadId}`, origin).toString());
  await page.locator("article").getByText("Loaded before the socket.").waitFor();
  await expect.poll(() => refused).toBeGreaterThan(0);

  await seedMessage(db, box, {
    subject: "Re: Kickoff",
    fromAddress: "pm@client.test",
    uid: 2,
    threadId: first.threadId,
    text: "Sent before the socket opened.",
  });
  refuse = false;

  await page.locator("article").getByText("Sent before the socket opened.").waitFor();
});

test("replies written offline go out once each, in order, when the connection is back", async () => {
  const org = await createOrg(db, "offline");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@offline.test");
  await db
    .insert(schema.memberPreferences)
    .values({ memberId: ana.id, orgId: org.id, undoSendSeconds: 0 });
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

  const { page, tab } = await openApp("ana@offline.test", "/");
  let markedRead = false;
  let isOffline = false;
  let wentOffline!: () => void;
  const offline = new Promise<void>((resolve) => (wentOffline = resolve));
  await page.route("**/api/threads/*/state", async (route) => {
    await route.fulfill({ response: await route.fetch() });
    markedRead = true;
  });
  let countsHeld = 0;
  await page.route("**/api/counts*", async (route) => {
    if (!markedRead || isOffline) return route.continue();
    countsHeld++;
    await offline;
    await route.abort("internetdisconnected").catch(() => {});
  });
  await page.goto(new URL(`/inbox/${thread.id}`, origin).toString());
  await page.locator("article").getByText("body of Plans").waitFor();
  await expect.poll(() => countsHeld).toBeGreaterThan(0);

  let replyRequests = 0;
  await page.route("**/api/threads/*/reply", async (route) => {
    replyRequests++;
    if (replyRequests > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });

  await tab.setOffline(true);
  isOffline = true;
  wentOffline();
  const notice = page.locator("[data-slot=toast]").filter({ hasText: "You're offline" });
  await notice.waitFor();
  const reply = async (text: string) => {
    const box = page.getByRole("textbox", { name: "Reply" });
    if (!(await box.isVisible())) {
      await page.getByRole("button", { name: "Reply", exact: true }).last().click();
    }
    await box.fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };
  await reply("First, offline.");
  await reply("Second, offline.");
  await notice.filter({ hasText: "2 queued" }).waitFor();
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
  await notice.waitFor({ state: "detached", timeout: 30_000 });
  expect(replyRequests).toBe(3);
  const queued = await sends();
  expect(queued.map((row) => (row.payload as { text: string }).text)).toEqual([
    "First, offline.",
    "Second, offline.",
  ]);
  await expect
    .poll(() => page.locator("article").getByText("Queued", { exact: true }).count())
    .toBe(2);

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

test("a conversation opened offline says so instead of loading forever, then loads once back", async () => {
  const org = await createOrg(db, "offline-open");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@offline-open.test");
  const box = await createMailbox(db, org.id, "ana@offline-open.test", "personal");
  await grant(db, org.id, box.id, ana.id);
  await seedMessage(db, box, {
    subject: "Never opened",
    fromAddress: "pm@client.test",
    uid: 1,
    text: "Only loads once back online.",
  });

  const { page, tab } = await openApp("ana@offline-open.test", "/inbox");
  const row = page.getByText("Never opened").first();
  await row.waitFor();
  await tab.setOffline(true);
  await row.click();

  const pane = page.getByRole("region", { name: "Conversation" });
  await pane.getByText("You're offline").waitFor();
  expect(await pane.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
  await page.locator("[data-slot=toast]").filter({ hasText: "You're offline" }).waitFor();

  await tab.setOffline(false);
  await page
    .locator("article")
    .getByText("Only loads once back online.")
    .waitFor({ timeout: 30_000 });
});

test("launched with the API unreachable it shows the offline screen, then the inbox once back", async () => {
  const org = await createOrg(db, "cold-start");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, "ana@cold-start.test");
  const box = await createMailbox(db, org.id, "ana@cold-start.test", "personal");
  await grant(db, org.id, box.id, ana.id);
  await seedMessage(db, box, { subject: "Waiting", fromAddress: "pm@client.test", uid: 1 });

  const { page, tab } = await openApp("ana@cold-start.test", "/settings");
  await page.waitForLoadState("networkidle");
  await tab.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.goto(new URL("/inbox", origin).toString());
  await page.getByText("You're offline").waitFor();

  await tab.unroute("**/api/**");
  await page.getByText("Waiting").first().waitFor({ timeout: 30_000 });
  await expect.poll(() => page.getByText("You're offline").count()).toBe(0);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: free } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return free;
}
