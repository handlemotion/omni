// A newsletter's remote images in a real Chromium, on the web app served by the real Worker, on
// a real Postgres and the Worker's local R2. The HTML is what the mail service stores: the real
// sanitizer with remote images blocked. The image comes from a real HTTP server on another
// origin through the real image proxy.
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

// A 1x1 PNG.
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
    // The image proxy refuses private addresses; the image server is the one exception.
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

// Catches: remote images that never load, because nothing swaps the blocked URL back in, or that
// load straight from the sender instead of through the image proxy (ADR 0041).
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

  // Opens as the sender laid it out, the image fetched through our proxy, never from the sender.
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
