// The sidebar's mailbox switcher in a real Chromium, on the web app built and served by the real
// Worker under `wrangler dev`, on a real Postgres. The profile picture comes from a real HTTP
// server on another origin, the way a Google account's photo does.
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

/** Where a URL is inside its workspace: `/mail/inbox` for `/<slug>/mail/inbox` (ADR 0043). */
const place = (url: URL | string) => `/${new URL(url).pathname.split("/").slice(2).join("/")}`;

// A 1x1 PNG.
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
      // Auth accepts the page's own requests (switching workspace is a POST).
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      // The image proxy refuses private addresses; the picture server is the one exception.
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

/** Ana: owner of two workspaces (Acme active), a personal and a shared mailbox in each, with a
 *  photo; one unread thread in Acme's shared inbox, two in Beta's. */
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

/** Signed in, on the inbox, with the switcher open. */
async function openSwitcher(
  email: string,
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<Page> {
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
  return page;
}

test("your photo from another site shows on your personal mailbox", async () => {
  const { email } = await ana("photo");
  const page = await openSwitcher(email);
  const photos = page.getByRole("menuitem", { name: /Ana Lima/ }).locator("img");
  await expect.poll(() => photos.count()).toBe(1);
  // Loaded, not refused by the page's CSP: the app's img-src allows only its own origin.
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

// Catches: the mailbox menu, "All", its rows or the sidebar's unread count reaching into a
// workspace other than the active one (ADR 0014, amended: workspace isolation).
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

  // Beta active, through the sidebar's workspace menu: its mailboxes, its mail and its count,
  // and none of Acme's.
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

// Catches: rows cropped to their content (a layout width of NaN), an empty reading column left
// standing with nothing open, or a thread that the top bar's close doesn't close.
test("the list fills the page until a thread opens beside it, and again once it closes", async () => {
  const { email } = await ana("wide");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: "Hello from Acme" });
  await row.waitFor();
  const list = page.getByRole("grid");
  const width = async (locator: typeof row) => (await locator.boundingBox())?.width ?? 0;
  // Alone, the list (and every row in it) runs to the window's edge, but for the rows' 10px
  // inset (`mx-2.5`). `gap` is the room past that inset: 0 alone, the reader's width beside it.
  const INSET = 10;
  const viewport = page.viewportSize()?.width ?? 0;
  const gap = async () => {
    const box = await row.boundingBox();
    return viewport - INSET - (box ? box.x + box.width : 0);
  };
  await expect.poll(async () => Math.abs(await gap())).toBeLessThan(2);
  expect(Math.abs((await width(list)) - (await width(row)) - 2 * INSET)).toBeLessThan(2);

  // Open, the thread takes the right of the page; the list keeps the rest.
  await row.click();
  await page.waitForURL((url) => place(url).startsWith("/mail/inbox/"));
  await page.getByRole("button", { name: "Reply", exact: true }).last().waitFor();
  await expect.poll(gap).toBeGreaterThan(400);

  // The top bar's close goes back to the list alone.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForURL((url) => place(url) === "/mail/inbox");
  await expect.poll(async () => Math.abs(await gap())).toBeLessThan(2);

  // New mail opens in a dialog over the page and closes back to it.
  // The list's own Compose (the sidebar has one too).
  await page.getByRole("main").getByRole("button", { name: "Compose" }).click();
  const dialog = page.getByRole("dialog", { name: "New email" });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
});

// Catches: a sidebar link that drops (or swaps) the mailbox the switcher shows.
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
    // Inbox's name carries its unread count ("Inbox 3").
    await page.getByRole("link", { name: new RegExp(`^${name}( \\d+)?$`) }).click();
    await page.waitForURL((url) => place(url) === path);
    expect(new URL(page.url()).searchParams.get("mailbox")).toBe(boxes.support.id);
    await page.getByRole("button", { name: /^Switch mailbox, currently Support/ }).waitFor();
  }
});

// Catches: switching mailbox (or back to All) throwing the person back to the Inbox.
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

// Catches: a workspace switch from Drive throwing the person back to mail (or into a folder of
// the workspace left behind), and a module switch that changes the workspace.
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
  // Drive alone: mail's rows are gone.
  expect(await page.getByRole("link", { name: "Later", exact: true }).count()).toBe(0);

  await page.getByRole("link", { name: "Trash", exact: true }).click();
  await page.waitForURL((url) => place(url) === "/files/trash");
  const other = before === acme.orgId ? "Beta" : "Acme";
  await page.getByRole("button", { name: /^Switch workspace, currently / }).click();
  await page.getByRole("menuitem", { name: other }).click();
  await page.getByRole("button", { name: `Switch workspace, currently ${other}` }).waitFor();
  await page.getByRole("button", { name: "Switch module, currently Drive" }).waitFor();
  expect(place(page.url())).toBe("/files/trash");
  // The session follows the tab, so the next load and other clients start where it is.
  await expect.poll(active).toBe(other === "Beta" ? beta.orgId : acme.orgId);
});

// Catches: `g` then `f` opening Drive without the mailbox shown, so coming back to Mail lands on
// All mailboxes instead of the one that was chosen.
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

// Catches: a thread from another workspace, opened by its link, shown inside the workspace on
// screen (its chrome, its lists) instead of its own, or never updating live once there.
test("a thread from another workspace, opened by link, moves to its workspace and shows new mail live", async () => {
  const { email, boxes, beta, betaHello } = await ana("live");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  await page.goto(new URL(`/inbox/${betaHello.threadId}`, String(worker.url)).toString());
  await page.getByText("Hello from Beta").first().waitFor();
  // The page is Beta's now: its URL, its sidebar, and its lists beside the thread.
  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).waitFor();
  expect(new URL(page.url()).pathname).toBe(`/${beta.slug}/mail/inbox/${betaHello.threadId}`);
  expect(await page.getByRole("row").filter({ hasText: "Acme" }).count()).toBe(0);

  // A reply lands in the thread, the way the mail service records and announces it.
  const reply = await seedMessage(db, boxes.hello, {
    subject: "Re: Hello from Beta",
    fromAddress: "x@y.test",
    uid: 3,
    threadId: betaHello.threadId,
    text: "A reply that arrives while the thread is open",
  });
  // Until Beta's socket is open, an event would reach nobody: wait for it.
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

// Catches: a send from another workspace's address failing silently. Only the active
// workspace's socket was open, and the outbox announces a send's failure on the sender's own
// workspace socket, so once the compose dialog closed nothing heard it; and a workspace switch
// (which clears the query cache) forgetting the send, closing that socket before its result.
test("a send from another workspace's address hears its failure after the dialog closes and a workspace switch", async () => {
  const { email, beta, boxes } = await ana("sendfail");
  await ensurePersonalSpace(db, beta.userId);
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);
  await sendNewMail(page, boxes.hello.address);
  // To a third workspace (neither Acme nor Beta), through the sidebar's workspace menu.
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).click();
  await page.getByRole("menuitem", { name: /(?:'s|^Personal) Workspace$/ }).click();
  await page.getByRole("button", { name: /^Switch workspace, currently .*Workspace$/ }).waitFor();

  const action = await sentFrom(boxes.hello.id);
  // The mail service gives up on it, after the dialog has closed.
  const failure = {
    type: "action.failed" as const,
    orgId: beta.orgId,
    mailboxId: boxes.hello.id,
    actionId: action.id,
    memberId: beta.memberId,
    error: "550 mailbox unavailable",
  };
  // Until Beta's socket is open, the event would reach nobody: repeat it (receivers key on
  // `actionId`, so a repeat is harmless).
  await expect
    .poll(
      async () => {
        expect((await postMailEvents(worker, { events: [failure] })).status).toBe(202);
        return betaSockets.some((socket) => socket.frames.some((f) => f.includes(action.id)));
      },
      { timeout: 10_000, interval: 500 },
    )
    .toBe(true);
  // Heard: nothing more to wait for, so Beta's socket closes again.
  await expect.poll(() => betaSockets.every((socket) => socket.closed())).toBe(true);
});

// Catches: a send from another workspace's address that goes out never closing that
// workspace's socket. Nothing announces a send that succeeded, so the socket stayed open, and
// while it is open the member counts as online there and gets no push for its new mail.
test("a send from another workspace's address that goes out closes that workspace's socket", async () => {
  const { email, beta, boxes } = await ana("sendok");
  const page = await openSwitcher(email);
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);
  await sendNewMail(page, boxes.hello.address);
  await betaSockets.opened;
  const action = await sentFrom(boxes.hello.id);
  // The mail service sends it and records that, as `actions.complete()` does: no event.
  await db
    .update(schema.mailActions)
    .set({ status: "done" })
    .where(eq(schema.mailActions.id, action.id));
  // Within the recheck interval (10 s), Beta's socket closes; Acme's stays.
  await expect
    .poll(() => betaSockets.every((socket) => socket.closed()), { timeout: 15_000 })
    .toBe(true);
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).waitFor();
});

// Catches: a send whose result comes after its workspace's socket has closed never being heard.
// Tracking stopped with the socket (2 min), and a thread opened again is a new socket, not a
// reconnect, so nothing asked the outbox again: the reply stayed "sending" though it failed.
// The page's clock is Playwright's, so the 2 minutes pass at once; the server's is real.
// (`passTime` keeps the sockets' pings answered, so no reconnect asks the outbox instead.)
test("a reply from another workspace that fails after its socket closed shows as not sent", async () => {
  const { email, beta, boxes, betaHello } = await ana("late");
  let pings: Pings | undefined;
  const page = await openSwitcher(email, (p) => {
    pings = trackPings(p);
    return p.clock.install();
  });
  await page.keyboard.press("Escape");
  const betaSockets = watchSockets(page, beta.orgId);

  // Beta's thread, opened by link (it moves the page to Beta), takes a reply.
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

  // Away to Acme (in the app, no reload), past the send's 2 minutes: Beta's socket closes.
  await page.getByRole("button", { name: "Switch workspace, currently Beta" }).click();
  await page.getByRole("menuitem", { name: "Acme" }).click();
  await page.getByRole("button", { name: "Switch workspace, currently Acme" }).waitFor();
  await passTime(page, pings!, 130_000);
  await expect.poll(() => betaSockets.every((socket) => socket.closed())).toBe(true);

  // The outbox gives up on it, with no event (none would reach a closed socket anyway).
  await db
    .update(schema.mailActions)
    .set({ status: "failed", lastError: "550 mailbox unavailable" })
    .where(eq(schema.mailActions.id, action.id));
  await passTime(page, pings!, 65_000);

  // Back in the thread, the reply shows it was not sent.
  await page.goBack();
  await page.waitForURL((url) => place(url).startsWith("/mail/inbox/"));
  await page.getByText("Not sent: 550 mailbox unavailable").waitFor({ timeout: 10_000 });
});

type Pings = ReturnType<typeof trackPings>;

/** The page's sockets' pings: `answered()` resolves once each open socket has its pongs. */
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

/**
 * Moves the page's installed clock on by `ms` in 5 s steps, each once the sockets' pings so far
 * have their pongs: one jump would fire two pings with no pong between them, and the reconnect
 * that follows would ask the outbox about every reply, hiding what is under test.
 */
async function passTime(page: Page, pings: Pings, ms: number) {
  for (let passed = 0; passed < ms; passed += 5_000) {
    await page.clock.runFor(5_000);
    await pings.answered();
  }
}

/** Every socket the page opens for `orgId`: the frames it receives, and whether it closed. */
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

/** Sends a new email from `address` through the compose dialog, which closes on send. */
async function sendNewMail(page: Page, address: string) {
  // The list's own Compose (the sidebar has one too).
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

/** The send the outbox holds for `mailboxId`. */
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
