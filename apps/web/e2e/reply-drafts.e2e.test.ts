import { createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
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

const savedBody = async (threadId: string) =>
  (await db.select().from(schema.drafts).where(eq(schema.drafts.threadId, threadId)))[0]?.bodyText;

async function typeAndSave(page: Page, threadId: string, words: string) {
  const body = page.getByRole("textbox", { name: "Reply" });
  await expect.poll(() => body.isEditable(), { timeout: 10_000 }).toBe(true);
  await body.click();
  await page.keyboard.press("ControlOrMeta+End");
  await body.pressSequentially(words);
  await expect.poll(() => savedBody(threadId), { timeout: 10_000 }).toContain(words);
}

test("a reply draft comes back where it was left, in the thread and from Drafts", async () => {
  const email = "ana@drafts.test";
  const system = await createOrg(db, "drafts-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "drafts", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const { threadId } = await seedMessage(db, box, {
    subject: "Onboarding papers",
    fromAddress: "paola@school.test",
    uid: 1,
    text: "Hi Ana, please send the forms.",
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
  const body = page.getByRole("textbox", { name: "Reply" });
  const row = page.getByRole("row").filter({ hasText: "Onboarding papers" });
  await page.goto(new URL(`/inbox/${threadId}`, origin).toString());

  await page.getByRole("button", { name: "Reply", exact: true }).first().click();
  await typeAndSave(page, threadId, "First line.");
  await typeAndSave(page, threadId, " Second line.");

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await row.click();
  await expect.poll(() => body.inputValue()).toContain("First line. Second line.");

  await typeAndSave(page, threadId, " Third line.");
  await page.getByRole("link", { name: "Drafts" }).click();
  await row.click();
  await expect.poll(() => body.inputValue()).toContain("Second line. Third line.");

  await page.getByRole("button", { name: "Send" }).click();
  await body.waitFor({ state: "detached" });
  await context.close();
});
