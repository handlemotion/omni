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
  await page.goto(new URL("/inbox", origin).toString());
  await shows(page, "mail");
  return page;
}

const LABELS = { mail: "Mail", files: "Drive", crm: "CRM" } as const;
const rail = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Modules" }).getByRole("link", { name, exact: true });
const shows = (page: Page, id: keyof typeof LABELS) =>
  page
    .getByRole("navigation", { name: "Modules" })
    .locator(`[aria-current="page"][aria-label="${LABELS[id]}"]`)
    .waitFor();
const pager = (page: Page) => page.locator('[data-slot="module-pager"]');

const pageAt = (page: Page) =>
  pager(page).evaluate((el) => {
    const sidebar = el.closest<HTMLElement>('[data-slot="sidebar"]');
    return Number(sidebar?.style.getPropertyValue("--module-at") || 0);
  });

const slideFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const track = document.querySelector<HTMLElement>('[data-slot="module-track"]');
        const seen: number[] = [];
        const start = performance.now();
        const frame = () => {
          if (track) {
            const x = new DOMMatrix(getComputedStyle(track).transform).m41;
            seen.push(-x / track.clientWidth);
          }
          if (performance.now() - start < 500) requestAnimationFrame(frame);
          else resolve(seen);
        };
        frame();
      }),
  );

async function swipe(page: Page, steps: [dx: number, dy: number][]) {
  const box = await pager(page).boundingBox();
  if (!box) throw new Error("no sidebar pages");
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  for (const [dx, dy] of steps) {
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(16);
  }
}

test("the rail opens each module and the pages glide along", async () => {
  const page = await openInbox("chevrons");
  const frames = slideFrames(page);
  await rail(page, "Drive").click();
  await page.waitForURL((url) => place(url) === "/files");
  await shows(page, "files");
  await expect.poll(() => pageAt(page)).toBe(1);
  expect((await frames).some((at) => at > 0.1 && at < 0.9)).toBe(true);

  await rail(page, "CRM").click();
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await shows(page, "crm");
  await expect.poll(() => pageAt(page)).toBe(2);

  await rail(page, "Drive").click();
  await page.waitForURL((url) => place(url) === "/files");
  await expect.poll(() => pageAt(page)).toBe(1);
});

test("a sideways swipe leaves the module where it is; only the rail moves between modules", async () => {
  const page = await openInbox("swipe");
  const width = await pager(page).evaluate((el) => el.clientWidth);
  await swipe(page, [
    [width * 0.4, 0],
    [width * 0.4, 0],
  ]);
  await swipe(page, [[-width * 0.7, 0]]);
  await swipe(page, [[0, 120]]);
  await page.waitForTimeout(400);
  expect(await pageAt(page)).toBe(0);
  expect(place(page.url())).toBe("/mail/inbox");
  await shows(page, "mail");
  const frame = await pager(page).boundingBox();
  const shown = await page.locator('[data-module-page="mail"]').boundingBox();
  expect(Math.round(shown?.x ?? -1)).toBe(Math.round(frame?.x ?? 0));
  expect(await pager(page).evaluate((el) => el.scrollLeft)).toBe(0);
});

test("each rail click stays on the module it opened", async () => {
  const page = await openInbox("restore", { reducedMotion: "reduce" });
  const wants = {
    CRM: "/crm/companies",
    Mail: "/mail/inbox",
    Calendar: "/calendar",
    Drive: "/files",
  } as const;
  for (const name of ["CRM", "Mail", "Calendar", "Mail", "Drive", "Calendar", "CRM"] as const) {
    await rail(page, name).click();
    await page.waitForURL((url) => place(url) === wants[name]);
    await page.waitForTimeout(400);
    expect(place(page.url())).toBe(wants[name]);
  }
});

test("a scroll the pages did not make snaps back and opens nothing", async () => {
  const page = await openInbox("stray");
  await pager(page).evaluate((el) => {
    el.scrollLeft = 2 * el.clientWidth;
  });
  await page.waitForTimeout(400);
  expect(place(page.url())).toBe("/mail/inbox");
  expect(await pageAt(page)).toBe(0);
  await shows(page, "mail");
});

test("Tab never lands in a module's page that isn't shown", async () => {
  const page = await openInbox("inert");
  const drive = page.locator('[data-module-page="files"] a').first();
  await drive.evaluate((link) => (link as HTMLElement).focus());
  expect(await drive.evaluate((link) => document.activeElement === link)).toBe(false);
  await rail(page, "Drive").click();
  await shows(page, "files");
  await drive.evaluate((link) => (link as HTMLElement).focus());
  expect(await drive.evaluate((link) => document.activeElement === link)).toBe(true);
});

test("switching module from the rail keeps a document's edits, and the pages glide there", async () => {
  const page = await openInbox("blocked");
  await rail(page, "Drive").click();
  await shows(page, "files");
  await page.goto(page.url().replace(/\/files.*$/, "/files/my"));
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "plan.md", mimeType: "text/markdown", buffer: Buffer.from("# Plan\n") });
  await page.getByRole("row", { name: /plan\.md/ }).click();
  const editor = page.locator("[contenteditable=true]");
  await editor.getByRole("heading", { name: "Plan" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" B");

  await rail(page, "CRM").click();
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await shows(page, "crm");
  await expect.poll(() => pageAt(page)).toBe(2);

  await page.goto(page.url().replace(/\/crm\/.*$/, "/files/my"));
  await page.getByRole("row", { name: /plan\.md/ }).click();
  await page.locator("[contenteditable=true]").getByRole("heading", { name: "Plan B" }).waitFor();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
