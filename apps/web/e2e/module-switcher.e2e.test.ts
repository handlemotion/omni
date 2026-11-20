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
  await shows(page, "Mail");
  return page;
}

const modules = (page: Page) => page.getByRole("group", { name: "Modules" });
const shows = (page: Page, label: string) =>
  modules(page).getByText(label, { exact: true }).waitFor();

async function swipe(page: Page, steps: [dx: number, dy: number][]) {
  await page.locator('[data-slot="sidebar-content"]').evaluate(
    (sidebar, deltas) =>
      new Promise<void>((resolve) => {
        const sendFrameApart = (at: number) => {
          const delta = deltas[at];
          if (!delta) return resolve();
          const [deltaX, deltaY] = delta;
          const init = { deltaX, deltaY, bubbles: true, cancelable: true };
          sidebar.dispatchEvent(new WheelEvent("wheel", init));
          setTimeout(() => sendFrameApart(at + 1), 16);
        };
        sendFrameApart(0);
      }),
    steps,
  );
  await page.waitForTimeout(400);
}

test("the chevrons step to the neighbouring module and stop at the ends", async () => {
  const page = await openInbox("chevrons");
  expect(await page.getByRole("button", { name: "No previous module" }).isDisabled()).toBe(true);

  await page.getByRole("button", { name: "Go to Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files/my");
  await shows(page, "Drive");

  await page.getByRole("button", { name: "Go to CRM" }).click();
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await shows(page, "CRM");
  expect(await page.getByRole("button", { name: "No next module" }).isDisabled()).toBe(true);

  await page.getByRole("button", { name: "Go to Drive" }).click();
  await page.waitForURL((url) => place(url) === "/files/my");
});

test("a sideways swipe in the sidebar moves one module per gesture, momentum and all", async () => {
  const page = await openInbox("swipe");
  await swipe(page, [
    [20, 2],
    [30, 1],
    [40, 0],
    [60, 0],
    [40, 0],
    [20, 0],
  ]);
  await page.waitForURL((url) => place(url) === "/files/my");
  await shows(page, "Drive");
  await page.waitForTimeout(300);
  expect(place(page.url())).toBe("/files/my");

  await swipe(page, [[60, 0]]);
  await page.waitForURL((url) => place(url) === "/crm/companies");
  await swipe(page, [[60, 0]]);
  await page.waitForTimeout(300);
  expect(place(page.url())).toBe("/crm/companies");

  await swipe(page, [[-60, 0]]);
  await page.waitForURL((url) => place(url) === "/files/my");
});

test("a vertical scroll that drifts sideways stays a scroll", async () => {
  const page = await openInbox("vertical");
  await swipe(page, [
    [0, 40],
    [80, 10],
    [80, 0],
  ]);
  await swipe(page, [[10, 120]]);
  await page.waitForTimeout(300);
  expect(place(page.url())).toBe("/mail/inbox");
  await shows(page, "Mail");
});

test("the sidebar keeps sideways swipes from the browser's back and forward", async () => {
  const page = await openInbox("history");
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    window.addEventListener("wheel", (event) => seen.push(event.defaultPrevented));
  });
  const seen = () => page.evaluate(() => (window as unknown as { seen: boolean[] }).seen);

  await swipe(page, [[-60, 0]]);
  expect(place(page.url())).toBe("/mail/inbox");
  expect(await seen()).toEqual([true]);

  await swipe(page, [[0, 60]]);
  expect((await seen()).at(-1)).toBe(false);

  await page
    .locator("body")
    .evaluate((body) =>
      body.dispatchEvent(new WheelEvent("wheel", { deltaX: -60, bubbles: true, cancelable: true })),
    );
  await expect.poll(async () => (await seen()).at(-1)).toBe(false);
});

test("the pill slides in from the side it came from, and not at all with reduced motion", async () => {
  const motion = await openInbox("motion");
  await motion.getByRole("button", { name: "Go to Drive" }).click();
  await shows(motion, "Drive");
  expect(await pillAnimation(motion, "Drive")).toBe("enter");
  await context?.close();

  const still = await openInbox("still", { reducedMotion: "reduce" });
  await still.getByRole("button", { name: "Go to Drive" }).click();
  await shows(still, "Drive");
  expect(await pillAnimation(still, "Drive")).toBe("none");
});

function pillAnimation(page: Page, label: string) {
  return modules(page)
    .getByText(label, { exact: true })
    .evaluate((name) => getComputedStyle(name.parentElement as Element).animationName);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
