// The ⌘K command menu in a real Chromium, on the web app served by the real Worker and a real
// Postgres: it opens from any module, finds a thread by its subject, and runs a thread command
// on the thread that is open.
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createTestDatabase,
  grant,
  seedMessage,
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

// Catches: ⌘K bound only where the mail list is mounted (Drive had no menu), a module's page or
// a settings page the menu can't reach, a scope pill that keeps focus so typing goes nowhere, and
// a command row that closes the menu without running its shortcut's handler.
test("⌘K opens the command menu anywhere, finds a thread and marks it done", async () => {
  const email = "ana@menu.test";
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "menu", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  await seedMessage(db, box, {
    subject: "Quarterly freight rates",
    fromAddress: "luis@carrier.test",
    uid: 1,
    text: "The new rates are attached.",
  });

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
  const menu = page.getByRole("dialog", { name: "Search and commands" });

  // Drive mounts no mail list, so this is the shell's binding, not the list header's.
  await page.goto(new URL("/menu/files/my", origin).toString());
  await page.getByRole("main").waitFor();
  await page.keyboard.press("Control+k");
  await menu.waitFor();
  await page.keyboard.press("Control+k");
  await menu.waitFor({ state: "hidden" });

  // A Drive page from the All pill, then a settings page from the Settings pill, found by a
  // word on the page rather than its title.
  await page.keyboard.press("/");
  await page.keyboard.type("shared with me");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/files\/shared-with-me$/);
  await menu.waitFor({ state: "hidden" });
  await page.keyboard.press("/");
  await menu.getByRole("radio", { name: "Settings" }).click();
  await page.keyboard.type("passkey");
  await menu.getByRole("option", { name: "Security" }).click();
  await page.waitForURL(/\/settings\/security$/);

  await page.goto(new URL("/menu/mail/inbox", origin).toString());
  const row = page.getByText("Quarterly freight rates").first();
  await row.waitFor();
  await page.keyboard.press("/");
  // The Mail pill lists the inbox before any query, and hands the keyboard back to the field, so
  // typing still filters.
  await menu.getByRole("radio", { name: "Mail" }).click();
  await menu.getByRole("option", { name: /Quarterly freight rates/ }).waitFor();
  await page.keyboard.type("freight");
  await expect.poll(() => menu.getByRole("combobox").inputValue()).toBe("freight");
  await menu.getByRole("option", { name: /Quarterly freight rates/ }).click();
  await page.waitForURL(/\/mail\/inbox\/.+/);

  await page.keyboard.press("Control+k");
  await page.keyboard.type("mark done");
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "hidden" });
  await page.goto(new URL("/menu/mail/inbox", origin).toString());
  await page.getByRole("main").waitFor();
  await expect.poll(() => page.getByText("Quarterly freight rates").count()).toBe(0);
  await context.close();
});
