import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, RATE_LIMIT_AUTH: "off" },
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

async function owner() {
  const org = await createOrg(db, `studio-${Date.now()}`);
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `owner-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const context = await browser.newContext({
    timezoneId: "Europe/Madrid",
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  return { org, page, origin };
}

async function watchNativeMenu(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { nativeMenu?: boolean };
    window.addEventListener("contextmenu", (event) => {
      w.nativeMenu = !event.defaultPrevented;
    });
  });
  return () => page.evaluate(() => (window as unknown as { nativeMenu?: boolean }).nativeMenu);
}

const menuItems = (page: Page) => page.getByRole("menuitem").allTextContents();

test("a right-click on an empty stretch of the week offers New event there, never the system menu", async () => {
  const { org, page, origin } = await owner();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=week`, origin).toString());
  const column = page.locator('[data-day="2026-11-24"]');
  await column.waitFor();
  const nativeMenu = await watchNativeMenu(page);

  await column.click({ button: "right", position: { x: 20, y: 10 * 48 + 6 } });
  await page.getByRole("menuitem", { name: "New event" }).click();
  expect(await nativeMenu()).toBe(false);
  const title = page.getByRole("textbox", { name: "Title" });
  await title.waitFor();
  await title.fill("Planning");
  await page.keyboard.press("Enter");

  const events = () =>
    db
      .select({ title: schema.calendarEvents.title, startsAt: schema.calendarEvents.startsAt })
      .from(schema.calendarEvents)
      .where(
        and(eq(schema.calendarEvents.orgId, org.id), eq(schema.calendarEvents.source, "omni")),
      );
  await expect.poll(async () => (await events()).map((e) => e.title)).toEqual(["Planning"]);
  expect((await events())[0]?.startsAt).toEqual(new Date("2026-11-24T09:00:00Z"));

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Planning/ }).click({ button: "right" });
  expect(await menuItems(page)).toEqual(["Open", "Edit", "Delete and tell guests"]);
});

test("a right-click on a settings row opens the items its ⋯ shows", async () => {
  const { org, page, origin } = await owner();
  const teammate = `ana-${Date.now()}@studio.example`;
  await createMember(db, org.id, teammate);
  await page.goto(new URL(`/${org.slug}/settings/people`, origin).toString());
  const dots = page.getByRole("button", { name: `Actions for ${teammate}` });
  await dots.waitFor();
  await dots.click();
  const fromDots = await menuItems(page);
  expect(fromDots.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.getByRole("menuitem").first().waitFor({ state: "hidden" });

  const nativeMenu = await watchNativeMenu(page);
  await page.getByText(teammate, { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem").first().waitFor();
  expect(await menuItems(page)).toEqual(fromDots);
  expect(await nativeMenu()).toBe(false);
  await page.keyboard.press("Escape");
  await page.getByRole("menuitem").first().waitFor({ state: "hidden" });

  const address = page.getByText(teammate, { exact: true });
  await address.selectText();
  await address.click({ button: "right" });
  await page.getByRole("menuitem").first().waitFor();
  expect(await menuItems(page)).toEqual(["Copy", ...fromDots]);
});

function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
