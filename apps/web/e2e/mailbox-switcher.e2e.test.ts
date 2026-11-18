import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, ensurePersonalSpace, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  postMailEvents,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

const place = (url: URL | string) => `/${new URL(url).pathname.split("/").slice(2).join("/")}`;

const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let pictures: Server;
let pictureOrigin: string;
let browser: Browser;
let context: BrowserContext | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  pictures = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "image/png" }).end(PICTURE),
  );
  await new Promise<void>((resolve) => pictures.listen(0, "127.0.0.1", resolve));
  pictureOrigin = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      IMAGE_PROXY_TEST_ALLOW_ORIGIN: pictureOrigin,
    },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await new Promise((resolve) => pictures?.close(resolve));
  await database?.teardown();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function ana(slug: string) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, {
    name: "Acme",
    slug: `${slug}-acme`,
    ownerEmail: email,
  });
  const beta = await createOrgWithOwner(db, {
    name: "Beta",
    slug: `${slug}-beta`,
    ownerEmail: email,
  });
  await db
    .update(schema.users)
    .set({ name: "Ana Lima", image: `${pictureOrigin}/ana.png` })
    .where(eq(schema.users.id, acme.userId));
  const boxes = {
    acme: await createMailbox(db, acme.orgId, email, "personal"),
    support: await createMailbox(db, acme.orgId, `support@${slug}.test`),
    beta: await createMailbox(db, beta.orgId, `ana@beta-${slug}.test`, "personal"),
    hello: await createMailbox(db, beta.orgId, `hello@beta-${slug}.test`),
  };
  await grant(db, acme.orgId, boxes.acme.id, acme.memberId);
  await grant(db, acme.orgId, boxes.support.id, acme.memberId);
  await grant(db, beta.orgId, boxes.beta.id, beta.memberId);
  await grant(db, beta.orgId, boxes.hello.id, beta.memberId);
  await seedMessage(db, boxes.support, {
    subject: "Hello from Acme",
    fromAddress: "x@y.test",
    uid: 1,
  });
  const betaHello = await seedMessage(db, boxes.hello, {
    subject: "Hello from Beta",
    fromAddress: "x@y.test",
    uid: 1,
  });
  await seedMessage(db, boxes.hello, { subject: "Beta again", fromAddress: "x@y.test", uid: 2 });
  return { email, acme, beta, boxes, betaHello };
}

async function openSwitcher(email: string, beforeLoad?: (page: Page) => Promise<void>) {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await beforeLoad?.(page);
  await page.goto(new URL("/inbox", origin).toString());
  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  await page.getByRole("menu").waitFor();
  return page satisfies Page;
}

test("your photo from another site shows on your personal mailbox", async () => {
  const { email } = await ana("photo");
  const page = await openSwitcher(email);
  const photos = page.getByRole("menuitem", { name: /Ana Lima/ }).locator("img");
  await expect.poll(() => photos.count()).toBe(1);
  for (const photo of await photos.all()) {
    await expect
      .poll(() =>
        photo.evaluate((img) => {
          const { complete, naturalWidth } = img as unknown as {
            complete: boolean;
            naturalWidth: number;
          };
          return complete && naturalWidth;
        }),
      )
      .toBe(1);
  }
});

test("a labelled inbox goes by its label and shows its own picture, not yours", async () => {
  const { email, acme } = await ana("labels");
  const work = await createMailbox(db, acme.orgId, "ana@work-labels.test", "personal");
  await grant(db, acme.orgId, work.id, acme.memberId);
  await db
    .update(schema.mailboxes)
    .set({ label: "Work", picture: `${pictureOrigin}/work.png` })
    .where(eq(schema.mailboxes.id, work.id));
  const page = await openSwitcher(email);
  const picture = (name: RegExp) =>
    page
      .getByRole("menuitem", { name })
      .locator("img")
      .evaluate((img) => decodeURIComponent((img as unknown as { src: string }).src));
  await expect.poll(() => picture(/^Work/)).toContain(`${pictureOrigin}/work.png`);
  await expect.poll(() => picture(/^Ana Lima/)).toContain(`${pictureOrigin}/ana.png`);

  await page.getByRole("menuitem", { name: /^Work/ }).click();
  await page.getByRole("button", { name: "Switch mailbox, currently Work" }).waitFor();
});

test("the menu and All show only the active workspace's mailboxes and mail", async () => {
  const { email } = await ana("isolate");
  const page = await openSwitcher(email);
  const menu = page.getByRole("menu");
  const addresses = async () =>
    (await menu.getByRole("menuitem").allInnerTexts()).map((text) => text.split("\n").at(-1));
  expect(await addresses()).toEqual(["2 mailboxes", "ana@isolate.test", "support@isolate.test"]);
  await page.keyboard.press("Escape");
  await page.getByRole("row").filter({ hasText: "Hello from Acme" }).waitFor();
  expect(await page.getByRole("row").filter({ hasText: "Beta" }).count()).toBe(0);
  await page.getByRole("link", { name: "Inbox 1", exact: true }).waitFor();

  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).click();
  await page.getByRole("menuitem", { name: "Beta" }).click();
  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).waitFor();
  await page.getByRole("row").filter({ hasText: "Hello from Beta" }).waitFor();
  await page.getByRole("row").filter({ hasText: "Beta again" }).waitFor();
  expect(await page.getByRole("row").filter({ hasText: "Acme" }).count()).toBe(0);
  await page.getByRole("link", { name: "Inbox 2", exact: true }).waitFor();
  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  await menu.waitFor();
  expect(await addresses()).toEqual([
    "2 mailboxes",
    "ana@beta-isolate.test",
    "hello@beta-isolate.test",
  ]);
});

test("the list fills the page until a thread opens beside it, and again once it closes", async () => {
  const { email } = await ana("wide");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: "Hello from Acme" });
  await row.waitFor();
  const list = page.getByRole("grid");
  const width = async (locator: typeof row) => (await locator.boundingBox())?.width ?? 0;
  const INSET = 10;
  const viewport = page.viewportSize()?.width ?? 0;
  const gap = async () => {
    const box = await row.boundingBox();
    return viewport - INSET - (box ? box.x + box.width : 0);
  };
  await expect.poll(async () => Math.abs(await gap())).toBeLessThan(2);
  expect(Math.abs((await width(list)) - (await width(row)) - 2 * INSET)).toBeLessThan(2);

  await row.click();
  await page.waitForURL((url) => place(url).startsWith("/mail/inbox/"));
  await page.getByRole("button", { name: "Reply", exact: true }).last().waitFor();
  await expect.poll(gap).toBeGreaterThan(400);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL((url) => place(url) === "/mail/inbox");
  await expect.poll(async () => Math.abs(await gap())).toBeLessThan(2);

  await page.getByRole("main").getByRole("button", { name: "Compose" }).click();
  const dialog = page.getByRole("dialog", { name: "New email" });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
});

test("sidebar links keep the mailbox the switcher shows", async () => {
  const { email, boxes } = await ana("keep");
  const page = await openSwitcher(email);
  await page.getByRole("menuitem", { name: /support@keep/ }).click();
  await page.waitForURL((url) => url.searchParams.get("mailbox") === boxes.support.id);
  for (const [name, path] of [
    ["Later", "/mail/later"],
    ["All mail", "/mail/all"],
    ["Inbox", "/mail/inbox"],
  ] as const) {
    await page.getByRole("link", { name: new RegExp(`^${name}( \\d+)?$`) }).click();
    await page.waitForURL((url) => place(url) === path);
    expect(new URL(page.url()).searchParams.get("mailbox")).toBe(boxes.support.id);
    await page.getByRole("button", { name: /^Switch mailbox, currently Support/ }).waitFor();
  }
});

test("switching mailbox keeps the list on screen", async () => {
  const { email, boxes } = await ana("stay");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Later", exact: true }).click();
  await page.waitForURL((url) => place(url) === "/mail/later");
  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  await page.getByRole("menuitem", { name: /support@stay/ }).click();
  await page.waitForURL((url) => url.searchParams.get("mailbox") === boxes.support.id);
  expect(place(page.url())).toBe("/mail/later");

  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  await page.getByRole("menuitem", { name: /All mailboxes/ }).click();
  await page.waitForURL((url) => !url.searchParams.has("mailbox"));
  expect(place(page.url())).toBe("/mail/later");
});

test("switching workspace keeps the module; switching module keeps the workspace", async () => {
  const { email, acme, beta } = await ana("modules");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const active = () =>
    page.evaluate(() =>
      fetch("/api/workspaces")
        .then((r) => r.json() as Promise<{ activeOrganizationId: string }>)
        .then((w) => w.activeOrganizationId),
    );
  const before = await active();

  await page.getByRole("button", { name: "Switch module, currently Mail" }).click();
  await page.getByRole("menuitem", { name: "Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files/my");
  expect(await active()).toBe(before);
  expect(await page.getByRole("link", { name: "Later", exact: true }).count()).toBe(0);

  await page.getByRole("link", { name: "Trash", exact: true }).click();
  await page.waitForURL((url) => place(url) === "/files/trash");
  const other = before === acme.orgId ? "Beta" : "Acme";
  await page.getByRole("button", { name: /^Switch workspace, currently / }).click();
  await page.getByRole("menuitem", { name: other }).click();
  await page.getByRole("button", { name: `Switch workspace, currently ${other}` }).waitFor();
  await page.getByRole("button", { name: "Switch module, currently Drive" }).waitFor();
  expect(place(page.url())).toBe("/files/trash");
  await expect.poll(active).toBe(other === "Beta" ? beta.orgId : acme.orgId);
});

test("g then f keeps the mailbox for the way back to Mail", async () => {
  const { email, boxes } = await ana("gokeys");
  const page = await openSwitcher(email);
  await page.getByRole("menuitem", { name: /support@gokeys/ }).click();
  await page.waitForURL((url) => url.searchParams.get("mailbox") === boxes.support.id);
  await page.getByRole("row").filter({ hasText: "Hello from Acme" }).waitFor();

  await page.keyboard.press("g");
  await page.keyboard.press("f");
  await page.waitForURL((url) => place(url) === "/files/my");
  await page.getByRole("button", { name: "Switch module, currently Drive" }).click();
  await page.getByRole("menuitem", { name: "Mail" }).click();
  await page.waitForURL((url) => place(url) === "/mail/inbox");
  expect(new URL(page.url()).searchParams.get("mailbox")).toBe(boxes.support.id);
  await page.getByRole("button", { name: /^Switch mailbox, currently Support/ }).waitFor();
});

test("a thread from another workspace, opened by link, moves to its workspace and shows new mail live", async () => {
  const { email, boxes, beta, betaHello } = await ana("live");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  await page.goto(new URL(`/inbox/${betaHello.threadId}`, String(worker.url)).toString());
  await page.getByText("Hello from Beta").first().waitFor();
  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).waitFor();
  expect(new URL(page.url()).pathname).toBe(`/${beta.slug}/mail/inbox/${betaHello.threadId}`);
  expect(await page.getByRole("row").filter({ hasText: "Acme" }).count()).toBe(0);

  const reply = await seedMessage(db, boxes.hello, {
    subject: "Re: Hello from Beta",
    fromAddress: "x@y.test",
    uid: 3,
    threadId: betaHello.threadId,
    text: "A reply that arrives while the thread is open",
  });
  await expect
    .poll(
      async () => {
        const response = await postMailEvents(worker, {
          events: [
            {
              type: "message.created",
              folderRole: "inbox",
              orgId: boxes.hello.orgId,
              mailboxId: boxes.hello.id,
              threadId: betaHello.threadId,
              messageId: reply.messageId,
            },
          ],
        });
        expect(response.status).toBe(202);
        return page.getByText("A reply that arrives while the thread is open").count();
      },
      { timeout: 10_000, interval: 500 },
    )
    .toBeGreaterThan(0);
});

test("a send from another workspace's address hears its failure after the dialog closes and a workspace switch", async () => {
  const { email, beta, boxes } = await ana("sendfail");
  await ensurePersonalSpace(db, beta.userId);
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);
  await sendNewMail(page, boxes.hello.address);
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).click();
  await page.getByRole("menuitem", { name: /(?:'s|^Personal) Workspace$/ }).click();
  await page.getByRole("button", { name: /^Switch workspace, currently .*Workspace$/ }).waitFor();

  const action = await sentFrom(boxes.hello.id);
  const failure = {
    type: "action.failed" as const,
    orgId: beta.orgId,
    mailboxId: boxes.hello.id,
    actionId: action.id,
    memberId: beta.memberId,
    error: "550 mailbox unavailable",
  };
  await expect
    .poll(
      async () => {
        expect((await postMailEvents(worker, { events: [failure] })).status).toBe(202);
        return betaSockets.some((socket) => socket.frames.some((f) => f.includes(action.id)));
      },
      { timeout: 10_000, interval: 500 },
    )
    .toBe(true);
  await expect.poll(() => betaSockets.every((socket) => socket.closed())).toBe(true);
});

test("a send from another workspace's address that goes out closes that workspace's socket", async () => {
  const { email, beta, boxes } = await ana("sendok");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);
  await sendNewMail(page, boxes.hello.address);
  await betaSockets.opened;
  const action = await sentFrom(boxes.hello.id);
  await db
    .update(schema.mailActions)
    .set({ status: "done" })
    .where(eq(schema.mailActions.id, action.id));
  await expect
    .poll(() => betaSockets.every((socket) => socket.closed()), { timeout: 15_000 })
    .toBe(true);
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).waitFor();
});

test("a reply from another workspace that fails after its socket closed shows as not sent", async () => {
  const { email, beta, boxes, betaHello } = await ana("late");
  let pings: Pings | undefined;
  const page = await openSwitcher(email, (p) => {
    pings = trackPings(p);
    return p.clock.install();
  });
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);

  await page.goto(new URL(`/inbox/${betaHello.threadId}`, String(worker.url)).toString());
  await page.getByText("Hello from Beta").first().waitFor();
  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).waitFor();
  await page.getByRole("button", { name: "Reply", exact: true }).last().click();
  await page.getByRole("textbox", { name: "Reply" }).fill("On my way");
  await page.getByRole("button", { name: "Send", exact: true }).last().click();
  const action = await expect
    .poll(async () => (await sentFrom(boxes.hello.id).catch(() => null))?.id ?? "")
    .not.toBe("")
    .then(() => sentFrom(boxes.hello.id));

  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).click();
  await page.getByRole("menuitem", { name: "Acme" }).click();
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).waitFor();
  await passTime(page, pings!, 130_000);
  await expect.poll(() => betaSockets.every((socket) => socket.closed())).toBe(true);

  await db
    .update(schema.mailActions)
    .set({ status: "failed", lastError: "550 mailbox unavailable" })
    .where(eq(schema.mailActions.id, action.id));
  await passTime(page, pings!, 65_000);

  await page.goBack();
  await page.waitForURL((url) => place(url).startsWith("/mail/inbox/"));
  await page.getByText("Not sent: 550 mailbox unavailable").waitFor({ timeout: 10_000 });
});

type Pings = ReturnType<typeof trackPings>;

function trackPings(page: Page) {
  const sockets = new Set<{ unanswered: number; closed: boolean }>();
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const waiter of waiters) waiter();
  };
  page.on("websocket", (ws) => {
    const socket = { unanswered: 0, closed: false };
    sockets.add(socket);
    ws.on("framesent", (frame) => {
      if (frame.payload === "ping") socket.unanswered++;
    });
    ws.on("framereceived", (frame) => {
      if (frame.payload !== "pong") return;
      socket.unanswered = 0;
      changed();
    });
    ws.on("close", () => {
      socket.closed = true;
      changed();
    });
  });
  return {
    async answered() {
      const done = Promise.withResolvers<void>();
      const check = () =>
        [...sockets].every((s) => s.closed || s.unanswered === 0) && done.resolve();
      waiters.add(check);
      check();
      await done.promise.finally(() => waiters.delete(check));
    },
  };
}

async function passTime(page: Page, pings: Pings, ms: number) {
  for (let passed = 0; passed < ms; passed += 5_000) {
    await page.clock.runFor(5_000);
    await pings.answered();
  }
}

function watchSockets(page: Page, orgId: string) {
  const sockets: { frames: string[]; closed: () => boolean }[] = [];
  const first = Promise.withResolvers<void>();
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`org=${orgId}`)) return;
    const frames: string[] = [];
    let closed = false;
    socket.on("framereceived", (frame) => frames.push(String(frame.payload)));
    socket.on("close", () => (closed = true));
    sockets.push({ frames, closed: () => closed });
    first.resolve();
  });
  return Object.assign(sockets, { opened: first.promise });
}

async function sendNewMail(page: Page, address: string) {
  await page.getByRole("main").getByRole("button", { name: "Compose" }).click();
  const dialog = page.getByRole("dialog", { name: "New email" });
  await dialog.getByRole("button", { name: /^From / }).click();
  await page
    .getByRole("menuitemradio", { name: address })
    .or(page.getByRole("menuitem", { name: address }))
    .click();
  await dialog.getByRole("button", { name: `From ${address}` }).waitFor();
  await dialog.getByRole("combobox", { name: "To" }).fill("client@example.test");
  await dialog.getByRole("combobox", { name: "To" }).press("Enter");
  await dialog.getByRole("textbox", { name: "Subject" }).fill("From another workspace");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

async function sentFrom(mailboxId: string) {
  const [action] = await db
    .select({ id: schema.mailActions.id })
    .from(schema.mailActions)
    .where(eq(schema.mailActions.mailboxId, mailboxId));
  if (!action) throw new Error("no send queued");
  return action;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
