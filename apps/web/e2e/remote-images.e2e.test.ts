import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { sanitizeHtml } from "@omni/mail-core/clean";
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let images: Server;
let imageOrigin: string;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  images = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "image/png" }).end(PNG),
  );
  await new Promise<void>((resolve) => images.listen(0, "127.0.0.1", resolve));
  imageOrigin = `http://127.0.0.1:${(images.address() as AddressInfo).port}`;
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { IMAGE_PROXY_TEST_ALLOW_ORIGIN: imageOrigin },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.server.close();
  await mailService?.close();
  if (images) await new Promise((resolve) => images.close(resolve));
  await database?.teardown();
});

test("a newsletter's remote images load on open, through the image proxy", async () => {
  const email = "ana@images.test";
  const system = await createOrg(db, "images-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "images", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const { threadId, messageId } = await seedMessage(db, box, {
    subject: "Get more done",
    fromAddress: "team@notion.test",
    uid: 1,
    text: "Hi Ana, experts are here to help.",
  });

  const sanitized = sanitizeHtml(
    `<p>Hi Ana</p><img alt="Banner" src="${imageOrigin}/banner.png">`,
    {
      proxyUrl: (src) => `/api/image-proxy?url=${encodeURIComponent(src)}`,
      cidUrl: () => null,
    },
  );
  const htmlKey = `${org.orgId}/${box.id}/html/${messageId}.html`;
  const env = await worker.server
    .getWorker<{ MAIL_BUCKET: { put(key: string, body: string): Promise<unknown> } }>()
    .getEnv();
  await env.MAIL_BUCKET.put(htmlKey, sanitized.html);
  await db
    .update(schema.messages)
    .set({ htmlR2Key: htmlKey, remoteImageCount: sanitized.remoteImageCount })
    .where(eq(schema.messages.id, messageId));

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
  await page.goto(new URL(`/inbox/${threadId}`, origin).toString());

  const frame = page.frameLocator('iframe[title="Full message"]');
  const banner = frame.getByRole("img", { name: "Banner" });
  await banner.waitFor();
  await expect
    .poll(() =>
      banner.evaluate((img) => {
        const { complete, naturalWidth } = img as unknown as {
          complete: boolean;
          naturalWidth: number;
        };
        return complete && naturalWidth;
      }),
    )
    .toBe(1);
  expect(await banner.getAttribute("src")).toBe(
    `/api/image-proxy?url=${encodeURIComponent(`${imageOrigin}/banner.png`)}`,
  );
  await context.close();
});

test("a right-click on a link in an email's HTML offers the app's Open link and Copy link", async () => {
  const email = "ana@links.test";
  const system = await createOrg(db, "links-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, { name: "Acme", slug: "links", ownerEmail: email });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const { threadId, messageId } = await seedMessage(db, box, {
    subject: "Your invoice",
    fromAddress: "billing@vendor.test",
    uid: 1,
    text: "Your invoice is ready.",
  });
  const sanitized = sanitizeHtml(
    `<p>Your invoice is ready: <a href="https://vendor.test/invoice/42">View invoice</a></p>`,
    { proxyUrl: (src) => src, cidUrl: () => null },
  );
  const htmlKey = `${org.orgId}/${box.id}/html/${messageId}.html`;
  const env = await worker.server
    .getWorker<{ MAIL_BUCKET: { put(key: string, body: string): Promise<unknown> } }>()
    .getEnv();
  await env.MAIL_BUCKET.put(htmlKey, sanitized.html);
  await db
    .update(schema.messages)
    .set({ htmlR2Key: htmlKey })
    .where(eq(schema.messages.id, messageId));

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
  await page.goto(new URL(`/inbox/${threadId}`, origin).toString());
  await page
    .getByText("Your invoice is ready.")
    .filter({ visible: true })
    .last()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show full message" }).click();

  const link = page
    .frameLocator('iframe[title="Full message"]')
    .getByRole("link", { name: "View invoice" });
  await link.waitFor();
  await link.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Open link", "Copy link"]);
  await context.close();
});

test("a right-click on a link in a plain-text email offers Open link and Copy link before the message's actions", async () => {
  const email = "ana@textlinks.test";
  const system = await createOrg(db, "textlinks-system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const org = await createOrgWithOwner(db, {
    name: "Acme",
    slug: "textlinks",
    ownerEmail: email,
  });
  const box = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, box.id, org.memberId);
  const { threadId } = await seedMessage(db, box, {
    subject: "Tracking",
    fromAddress: "ship@carrier.test",
    uid: 1,
    text: "Track it at https://carrier.test/track/7 today.",
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
  await page.goto(new URL(`/inbox/${threadId}`, origin).toString());

  const link = page
    .getByRole("link", { name: /carrier\.test\/track\/7/ })
    .filter({ visible: true });
  await link.waitFor();
  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).waitFor();
  const items = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
  expect(items.slice(0, 2)).toEqual(["Open link", "Copy link"]);
  expect(items).toContain("Reply");
  await context.close();
});
