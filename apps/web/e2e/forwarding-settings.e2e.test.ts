import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
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
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("an owner sets up forwarding for their mailbox in each workspace", async () => {
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = "rodrigo@chowmein.test";
  const company = await createOrgWithOwner(db, {
    name: "Chow Mein",
    slug: "chowmein",
    ownerEmail: email,
  });
  const other = await createOrgWithOwner(db, { name: "Side", slug: "side", ownerEmail: email });
  for (const [org, address] of [
    [company, email],
    [other, "rodrigo@side.test"],
  ] as const) {
    const box = await createMailbox(db, org.orgId, address, "personal");
    await db
      .insert(schema.mailboxAccess)
      .values({ orgId: org.orgId, mailboxId: box.id, memberId: org.memberId, role: "owner" });
  }

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
  await page.goto(new URL("/settings", origin).toString());
  await page
    .getByRole("link", { name: "Forwarding" })
    .or(page.getByText("Forwarding", { exact: true }))
    .first()
    .click();
  const row = page.getByText("rodrigo@chowmein.test", { exact: true });
  await row.waitFor();
  await page.getByText("rodrigo@side.test", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Options for rodrigo@chowmein.test" }).click();
  await page.getByRole("menuitem", { name: "Set up" }).click();
  await page.getByLabel("Forwarding address").fill("chowmein@attio.email");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("chowmein@attio.email").waitFor();
  await page.getByText("In sync").waitFor();

  const [saved] = await db
    .select({
      address: schema.mailboxes.forwardAddress,
      scope: schema.mailboxes.forwardScope,
      since: schema.mailboxes.forwardSince,
    })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.address, email));
  expect(saved).toMatchObject({ address: "chowmein@attio.email", scope: "conversations" });
  expect(saved?.since).toBeInstanceOf(Date);
  await context.close();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
