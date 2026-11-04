// The sidebar's mailbox switcher in a real Chromium, on the web app built and served by the real
// Worker under `wrangler dev`, on a real Postgres. The profile picture comes from a real HTTP
// server on another origin, the way a Google account's photo does.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

// A 1x1 PNG.
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let pictures: Server;
let pictureOrigin: string;
let browser: Browser;
let context: BrowserContext | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  pictures = createServer((_req, res) =>
    res.writeHead(200, { "content-type": "image/png" }).end(PICTURE),
  );
  await new Promise<void>((resolve) => pictures.listen(0, "127.0.0.1", resolve));
  pictureOrigin = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      // Auth accepts the page's own requests (switching workspace is a POST).
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      // The image proxy refuses private addresses; the picture server is the one exception.
      IMAGE_PROXY_TEST_ALLOW_ORIGIN: pictureOrigin,
    },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await new Promise((resolve) => pictures?.close(resolve));
  await database?.teardown();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
});

/** Ana: owner of two workspaces, a personal and a shared mailbox in each, with a photo. */
async function ana(slug: string) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, {
    name: "Acme",
    slug: `${slug}-acme`,
    ownerEmail: email,
  });
  const beta = await createOrgWithOwner(db, {
    name: "Beta",
    slug: `${slug}-beta`,
    ownerEmail: email,
  });
  await db
    .update(schema.users)
    .set({ name: "Ana Lima", image: `${pictureOrigin}/ana.png` })
    .where(eq(schema.users.id, acme.userId));
  const boxes = {
    acme: await createMailbox(db, acme.orgId, email, "personal"),
    support: await createMailbox(db, acme.orgId, `support@${slug}.test`),
    beta: await createMailbox(db, beta.orgId, `ana@beta-${slug}.test`, "personal"),
    hello: await createMailbox(db, beta.orgId, `hello@beta-${slug}.test`),
  };
  await grant(db, acme.orgId, boxes.acme.id, acme.memberId);
  await grant(db, acme.orgId, boxes.support.id, acme.memberId);
  await grant(db, beta.orgId, boxes.beta.id, beta.memberId);
  await grant(db, beta.orgId, boxes.hello.id, beta.memberId);
  await seedMessage(db, boxes.hello, {
    subject: "Hello from Beta",
    fromAddress: "x@y.test",
    uid: 1,
  });
  return { email, acme, beta, boxes };
}

/** Signed in, on the inbox, with the switcher open. */
async function openSwitcher(email: string): Promise<Page> {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL("/inbox", origin).toString());
  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  await page.getByRole("menu").waitFor();
  return page;
}

test("your photo from another site shows on your personal mailboxes", async () => {
  const { email } = await ana("photo");
  const page = await openSwitcher(email);
  const photos = page.getByRole("menuitem", { name: /Ana Lima/ }).locator("img");
  await expect.poll(() => photos.count()).toBe(2);
  // Loaded, not refused by the page's CSP: the app's img-src allows only its own origin.
  for (const photo of await photos.all()) {
    await expect
      .poll(() =>
        photo.evaluate((img) => {
          const { complete, naturalWidth } = img as unknown as {
            complete: boolean;
            naturalWidth: number;
          };
          return complete && naturalWidth;
        }),
      )
      .toBe(1);
  }
});

test("a mailbox in the other workspace opens; a switch the server refuses says so", async () => {
  const { email, beta, boxes } = await ana("switch");
  const page = await openSwitcher(email);

  await page.getByRole("menuitem", { name: /hello@beta-switch/ }).click();
  await page.waitForURL((url) => url.searchParams.get("mailbox") === boxes.hello.id);
  await page.getByRole("row").filter({ hasText: "Hello from Beta" }).waitFor();
  const active = await page.evaluate(() =>
    fetch("/api/workspaces").then((r) => r.json() as Promise<{ activeOrganizationId: string }>),
  );
  expect(active.activeOrganizationId).toBe(beta.orgId);

  // Ana loses the Acme workspace while the menu still lists it.
  await page.getByRole("button", { name: /^Switch mailbox/ }).click();
  const [acme] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
    .where(
      and(eq(schema.organizations.slug, "switch-acme"), eq(schema.members.userId, beta.userId)),
    );
  await db.delete(schema.mailboxAccess).where(eq(schema.mailboxAccess.memberId, acme!.id));
  await db.delete(schema.members).where(eq(schema.members.id, acme!.id));
  await page.getByRole("menuitem", { name: /support@switch/ }).click();

  await expect
    .poll(() => page.locator("[data-slot=toast][data-tone=error]").innerText())
    .toBe("The mailbox could not be opened. Try again.");
  expect(new URL(page.url()).searchParams.get("mailbox")).toBe(boxes.hello.id);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
