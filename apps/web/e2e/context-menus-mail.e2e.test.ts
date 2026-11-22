import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
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

const place = (url: URL | string) => `/${new URL(url).pathname.split("/").slice(2).join("/")}`;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
let context: BrowserContext | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function inbox(slug: string) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, { name: "Acme", slug, ownerEmail: email });
  const own = await createMailbox(db, acme.orgId, email, "personal");
  const support = await createMailbox(db, acme.orgId, `support@${slug}.test`);
  await grant(db, acme.orgId, own.id, acme.memberId);
  await grant(db, acme.orgId, support.id, acme.memberId);
  await seedMessage(db, own, {
    subject: "Quarterly numbers",
    fromAddress: "x@y.test",
    text: "Here are the numbers.",
    uid: 1,
  });

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
  await page.goto(new URL("/inbox", origin).toString());
  await page.getByRole("row", { name: /Quarterly numbers/ }).waitFor();
  return page;
}

const names = (menu: import("playwright-core").Locator) =>
  menu.getByRole("menuitem").allInnerTexts();

test("a thread row's right-click opens its actions, and Move to trash takes it out of the list", async () => {
  const page = await inbox("ctx-row");
  const row = page.getByRole("row", { name: /Quarterly numbers/ });
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Thread actions" });
  await menu.waitFor();
  expect(await names(menu)).toEqual([
    "Reply",
    "Forward",
    "Done",
    "Later",
    "Mark read",
    "Move to trash",
  ]);
  await menu.getByRole("menuitem", { name: "Move to trash" }).click();
  await row.waitFor({ state: "hidden" });
});

test("a sidebar list's right-click opens it, and the mailbox switcher's lists the mailboxes", async () => {
  const page = await inbox("ctx-sidebar");
  await page.getByRole("link", { name: "Sent" }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Mail" });
  expect(await names(menu)).toEqual(["Open", "New message"]);
  await menu.getByRole("menuitem", { name: "Open" }).click();
  await page.waitForURL((url) => place(url) === "/mail/sent");

  await page.getByRole("button", { name: /^Switch mailbox/ }).click({ button: "right" });
  const boxes = page.getByRole("menu", { name: "Switch mailbox" });
  expect(await names(boxes)).toEqual(["All mailboxes", "ana", "Support"]);
  await boxes.getByRole("menuitem", { name: "Support" }).click();
  await page.getByRole("button", { name: "Switch mailbox, currently Support" }).waitFor();
});

test("a message's right-click offers Reply and Forward, though its header shows them as buttons", async () => {
  const page = await inbox("ctx-message");
  await page.getByRole("row", { name: /Quarterly numbers/ }).click();
  await page
    .getByRole("region", { name: "Conversation" })
    .getByText("Here are the numbers.")
    .click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Message actions" });
  expect(await names(menu)).toEqual(["Reply", "Forward"]);
});

test("a right-click on a part of the page with no actions shows no menu, the system's included", async () => {
  const page = await inbox("ctx-empty");
  await page.evaluate(() => {
    const seen = window as unknown as { prevented?: boolean };
    window.addEventListener("contextmenu", (event) => (seen.prevented = event.defaultPrevented));
  });
  await page.getByRole("heading", { name: "Inbox" }).click({ button: "right" });
  const prevented = await page.evaluate(
    () => (window as unknown as { prevented?: boolean }).prevented,
  );
  expect(prevented).toBe(true);
  await page.waitForTimeout(300);
  expect(await page.getByRole("menu").count()).toBe(0);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
