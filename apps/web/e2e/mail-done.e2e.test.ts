import { createServer } from "node:http";
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

async function inbox(slug: string, subjects: string[]) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = `ana@${slug}.test`;
  const acme = await createOrgWithOwner(db, { name: "Acme", slug, ownerEmail: email });
  const own = await createMailbox(db, acme.orgId, email, "personal");
  const support = await createMailbox(db, acme.orgId, `support@${slug}.test`);
  await grant(db, acme.orgId, own.id, acme.memberId);
  await grant(db, acme.orgId, support.id, acme.memberId);
  for (const [uid, subject] of subjects.entries()) {
    await seedMessage(db, own, { subject, fromAddress: "x@y.test", text: "Hello.", uid: uid + 1 });
  }

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
  for (const subject of subjects) await page.getByRole("row", { name: subject }).waitFor();
  const access = and(
    eq(schema.mailboxAccess.mailboxId, own.id),
    eq(schema.mailboxAccess.memberId, acme.memberId),
  );
  return {
    page,
    revoke: () => db.delete(schema.mailboxAccess).where(access),
    regrant: () => grant(db, acme.orgId, own.id, acme.memberId),
  };
}

const DONE = /\/api\/threads\/[^/]+\/done(\?|$)/;

async function markDone(page: Page, subject: string) {
  await page.getByRole("row", { name: subject }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Thread actions" });
  await menu.getByRole("menuitem", { name: "Done" }).click();
  await menu.waitFor({ state: "hidden" });
}

async function seenWithin(page: Page, subjects: string[], ms: number) {
  const seen = new Set<string>();
  for (const until = Date.now() + ms; Date.now() < until;) {
    for (const subject of subjects) {
      if ((await page.getByRole("row", { name: subject }).count()) > 0) seen.add(subject);
    }
    await page.waitForTimeout(100);
  }
  return [...seen];
}

test("a thread marked done while the one before is still settling never comes back", async () => {
  const { page } = await inbox("done-race", ["Quarterly numbers", "Board deck"]);
  let posts = 0;
  await page.route(DONE, async (route) => {
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, posts === 1 ? 800 : 2_000));
    await route.continue();
  });
  await markDone(page, "Quarterly numbers");
  await markDone(page, "Board deck");
  expect(await seenWithin(page, ["Quarterly numbers", "Board deck"], 6_000)).toEqual([]);
  expect(posts).toBe(2);
});

test("a Done the server refuses brings the thread back with an error", async () => {
  const { page, revoke, regrant } = await inbox("done-refused", ["Quarterly numbers"]);
  const statuses: number[] = [];
  await page.route(DONE, async (route) => {
    await revoke();
    const response = await route.fetch();
    statuses.push(response.status());
    await regrant();
    await route.fulfill({ response });
  });
  await markDone(page, "Quarterly numbers");
  await page.getByText("That's no longer here.").waitFor();
  expect(statuses).toEqual([404]);
  expect(await page.getByRole("row", { name: "Quarterly numbers" }).isVisible()).toBe(true);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
