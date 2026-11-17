// Keyboard shortcuts in a real Chromium, on the web app served by the real Worker and a real
// Postgres: a module's keys work in that module only, and the ⌘K menu offers only those.
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

// Catches: the shell binding Mail's compose key for every module, so `c` in Drive or settings
// opens an email composer, and the ⌘K menu offering Compose where its key does nothing.
test("Mail's compose key works in Mail only, and ⌘K offers it there only", async () => {
  const email = "ana@keys.test";
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "keys", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);

  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  const composer = page.getByRole("dialog", { name: "New email" });
  const menu = page.getByRole("dialog", { name: "Search and commands" });
  const composeCommand = menu.getByRole("option", { name: /Compose/ });

  for (const path of ["/keys/files/my", "/keys/settings/profile"]) {
    await page.goto(new URL(path, origin).toString());
    await page.getByRole("main").waitFor();
    await page.keyboard.press("c");
    // The menu opens after the key, so by the time it shows the key has been handled.
    await page.keyboard.press("Control+k");
    await menu.waitFor();
    expect(await composer.isVisible()).toBe(false);
    expect(await composeCommand.count()).toBe(0);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  }

  // Go-to keys stay global: `g` then `i` from Drive lands in Mail, where `c` composes.
  await page.goto(new URL("/keys/files/my", origin).toString());
  await page.getByRole("main").waitFor();
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await page.waitForURL(/\/mail\/inbox$/);
  await page.keyboard.press("Control+k");
  await composeCommand.waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await page.keyboard.press("c");
  await composer.waitFor();
  await context.close();
});
