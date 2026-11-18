import { createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
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

test("after Done, the next email paints without going back to the network", async () => {
  const email = "ana@prefetch.test";
  const system = await createOrg(db, "prefetch-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "prefetch", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const env = await worker.server
    .getWorker<{ MAIL_BUCKET: { put(key: string, body: string): Promise<unknown> } }>()
    .getEnv();

  const seedHtml = async (subject: string, uid: number, sentAt: Date) => {
    const seeded = await seedMessage(db, box, {
      subject,
      fromAddress: "news@shop.test",
      uid,
      sentAt,
      text: "",
    });
    const htmlKey = `${org.orgId}/${box.id}/html/${seeded.messageId}.html`;
    await env.MAIL_BUCKET.put(htmlKey, `<p>${subject} body</p>`);
    await db
      .update(schema.messages)
      .set({ htmlR2Key: htmlKey })
      .where(eq(schema.messages.id, seeded.messageId));
    return seeded;
  };
  const first = await seedHtml("First sale", 1, new Date());
  const next = await seedHtml("Second sale", 2, new Date(Date.now() - 60_000));

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
  const warmed = page.waitForResponse((r) => r.url().endsWith(`/messages/${next.messageId}/html`));
  await page.goto(new URL(`/inbox/${first.threadId}`, origin).toString());
  const frame = page.frameLocator('iframe[title="Full message"]');
  await frame.getByText("First sale body").waitFor();
  await warmed;

  await context.setOffline(true);
  await page.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => page.url()).toContain(next.threadId);
  await frame.getByText("Second sale body").waitFor({ timeout: 5_000 });
  await context.close();
});
