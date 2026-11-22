import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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

async function openInbox(slug: string, options: { reducedMotion?: "reduce" } = {}) {
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, { name: "Acme", slug, ownerEmail: email });
  const box = await createMailbox(db, acme.orgId, email, "personal");
  await grant(db, acme.orgId, box.id, acme.memberId);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen: number[] = [];
    (window as unknown as { positions: number[] }).positions = seen;
    document.addEventListener(
      "scroll",
      () => {
        const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
        const at = sidebar?.style.getPropertyValue("--module-at");
        if (at) seen.push(Number(at));
      },
      { capture: true, passive: true },
    );
  });
  await page.goto(new URL("/inbox", origin).toString());
  await shows(page, "mail");
  return page;
}

const shows = (page: Page, id: "mail" | "files" | "crm") =>
  page.locator(`[role="group"][aria-label="Modules"][data-module="${id}"]`).waitFor();
const pager = (page: Page) => page.locator('[data-slot="module-pager"]');

const pageAt = (page: Page) =>
  pager(page).evaluate((el) => Math.round((el.scrollLeft / el.clientWidth) * 100) / 100);

async function swipe(page: Page, steps: [dx: number, dy: number][]) {
  const box = await pager(page).boundingBox();
  if (!box) throw new Error("no sidebar pages");
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  for (const [dx, dy] of steps) {
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(16);
  }
}

test("the chevrons step to the neighbouring module, the pages glide along, and stop at the ends", async () => {
  const page = await openInbox("chevrons");
  expect(await page.getByRole("button", { name: "No previous module" }).isDisabled()).toBe(true);

  await page.getByRole("button", { name: "Go to Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files");
  await shows(page, "files");
  await expect.poll(() => pageAt(page)).toBe(1);

  await page.getByRole("button", { name: "Go to CRM" }).click();
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await shows(page, "crm");
  await expect.poll(() => pageAt(page)).toBe(2);
  expect(await page.getByRole("button", { name: "No next module" }).isDisabled()).toBe(true);

  await page.getByRole("button", { name: "Go to Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files");
  await expect.poll(() => pageAt(page)).toBe(1);
});

test("a sideways swipe moves the pages under the fingers and opens the page it lets go on", async () => {
  const page = await openInbox("swipe");
  const width = await pager(page).evaluate((el) => el.clientWidth);
  await swipe(page, [
    [width * 0.2, 0],
    [width * 0.2, 0],
    [width * 0.2, 0],
  ]);
  await page.waitForURL((url) => place(url) === "/files");
  await shows(page, "files");
  await expect.poll(() => pageAt(page)).toBe(1);
  const positions = await page.evaluate(
    () => (window as unknown as { positions: number[] }).positions,
  );
  expect(positions.some((at) => at > 0.1 && at < 0.9)).toBe(true);

  await swipe(page, [[width * 0.7, 0]]);
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await expect.poll(() => pageAt(page)).toBe(2);

  await swipe(page, [[-width * 0.7, 0]]);
  await page.waitForURL((url) => place(url) === "/files");
  await expect.poll(() => pageAt(page)).toBe(1);
});

test("a short swipe springs back to the module it started on", async () => {
  const page = await openInbox("short");
  await swipe(page, [[30, 0]]);
  await expect.poll(() => pageAt(page)).toBe(0);
  await page.waitForTimeout(400);
  expect(place(page.url())).toBe("/mail/inbox");
  await shows(page, "mail");
});

test("a vertical scroll and a swipe past the first page stay on Mail", async () => {
  const page = await openInbox("vertical");
  await swipe(page, [[0, 120]]);
  await swipe(page, [[-200, 0]]);
  await page.waitForTimeout(400);
  expect(await pageAt(page)).toBe(0);
  expect(place(page.url())).toBe("/mail/inbox");
});

test("Tab never lands in a module's page that isn't shown", async () => {
  const page = await openInbox("inert");
  const drive = page.locator('[data-module-page="files"] a').first();
  await drive.evaluate((link) => (link as HTMLElement).focus());
  expect(await drive.evaluate((link) => document.activeElement === link)).toBe(false);
  await page.getByRole("button", { name: "Go to Drive" }).click();
  await shows(page, "files");
  await drive.evaluate((link) => (link as HTMLElement).focus());
  expect(await drive.evaluate((link) => document.activeElement === link)).toBe(true);
});

test("leaving a document with unsaved edits asks first; Cancel swipes the pages back", async () => {
  const page = await openInbox("blocked");
  await page.getByRole("button", { name: "Go to Drive" }).click();
  await shows(page, "files");
  await page.getByRole("button", { name: "Upload", exact: true }).first().waitFor();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Plan\n") });
  await page.getByRole("row", { name: /plan\.md/ }).click();
  const editor = page.locator("[contenteditable=true]");
  await editor.getByRole("heading", { name: "Plan" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" B");

  const width = await pager(page).evaluate((el) => el.clientWidth);
  await swipe(page, [[width * 0.7, 0]]);
  const leaving = page.getByRole("alertdialog", { name: "Save your changes?" });
  await leaving.waitFor({ timeout: 2000 });
  await leaving.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => pageAt(page)).toBe(1);
  expect(place(page.url())).toMatch(/^\/files\//);

  await page.getByRole("button", { name: "Go to CRM" }).click();
  await leaving.waitFor({ timeout: 1000 });
  await leaving.getByRole("button", { name: "Don’t save" }).click();
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await shows(page, "crm");
  await expect.poll(() => pageAt(page)).toBe(2);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
