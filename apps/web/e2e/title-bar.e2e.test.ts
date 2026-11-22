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
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
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

async function openInbox(slug: string) {
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, { name: "Acme", slug, ownerEmail: email });
  const box = await createMailbox(db, acme.orgId, email, "personal");
  await grant(db, acme.orgId, box.id, acme.memberId);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL("/inbox", origin).toString());
  await page.getByRole("button", { name: "Previous page" }).waitFor();
  return page;
}

const SHOTS = process.env.SHELL_SHOTS;

test("the title bar steps back and forward, opens search, and shows notifications at its right edge", async () => {
  const page = await openInbox("title-bar");
  const previous = page.getByRole("button", { name: "Previous page" });
  const next = page.getByRole("button", { name: "Next page" });
  const modules = page.getByRole("navigation", { name: "Modules" });
  await modules.getByRole("link", { name: "Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files");
  await previous.click();
  await page.waitForURL((url) => place(url).endsWith("/inbox"));
  await next.click();
  await page.waitForURL((url) => place(url) === "/files");
  await expect.poll(() => next.isDisabled()).toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bar.png` });

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Notifications" }).click();
  const panel = page.getByRole("complementary", { name: "Notifications" });
  await expect.poll(async () => Math.round((await panel.boundingBox())?.x ?? 0)).toBe(1280 - 432);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/panel.png` });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("on a phone, where the title bar is hidden, the mail list header still opens search", async () => {
  const page = await openInbox("title-bar-phone");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: "Previous page" }).waitFor({ state: "detached" });
  const search = page.getByRole("button", { name: "Search", exact: true });
  expect(await search.count()).toBe(1);
  await search.click();
  await page.getByRole("dialog", { name: "Search and commands" }).waitFor();
});
