// Company setup with Google (ADR 0024), in a real Chromium, on the web app built and served by
// the real Worker under `wrangler dev`, on a real Postgres: a company's Google accounts land in it
// by their address, so setup asks for the company's domain before it leaves for Google.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openClaim, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
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
    // Google is set up on this install, so setup offers it.
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, GOOGLE_CLIENT_ID: "e2e-google-client" },
    secrets: { GOOGLE_CLIENT_SECRET: "e2e-google-secret" },
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

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function signedIn(email: string, path: string): Promise<Page> {
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
  await page.goto(new URL(path, origin).toString());
  return page;
}

// Catches: setup leaving for Google before the company owns its domain, so every account it
// connects opens in the person's Personal space and the company is left with none.
test("adding a Google account in setup first claims the company's domain, mail staying at Google", async () => {
  const page = await signedIn(`founder-${Date.now()}@gmail.test`, "/onboarding");
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect your inbox" }).waitFor();

  await page
    .getByRole("button", { name: /Add account/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "Your company's domain" }).waitFor();
  expect(new URL(page.url()).host).toBe(new URL(String(worker.url)).host);

  const domain = `acme-${Date.now()}.test`;
  await page.getByLabel("Domain").fill(domain);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: `Verify you own ${domain}` }).waitFor();
  const claims = await db
    .select({ provider: schema.domainClaims.provider })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.domain, domain));
  expect(claims).toEqual([{ provider: "gmail" }]);

  // Back on the inbox step, the row now returns to the domain's DNS until it verifies.
  await page.getByRole("button", { name: "Back" }).click();
  await page
    .getByRole("button", { name: /Add account/ })
    .first()
    .click();
  await page.getByRole("heading", { name: `Verify you own ${domain}` }).waitFor();
});

// Catches: a domain already claimed on the other path (mail moving to Omni) standing in for the
// Google one, so the Google domain entered never opens its DNS.
test("the Google path keeps its own domain beside one claimed for Omni", async () => {
  const name = `Duo ${Date.now()}`;
  const page = await signedIn(`duo-${Date.now()}@gmail.test`, "/onboarding");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect your inbox" }).waitFor();
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.name, name));
  const [owner] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, org!.id));
  const omni = `omni-${Date.now()}.test`;
  await openClaim(db, {
    orgId: org!.id,
    domain: omni,
    memberId: owner!.id,
    challengeHash: "0".repeat(64),
    provider: "imap",
    dnsRecords: [],
  });
  // Setup resumes where that path stopped: the Omni domain's DNS.
  await page.reload();
  await page.getByRole("heading", { name: `Verify you own ${omni}` }).waitFor();
  await page.getByRole("button", { name: "Back" }).click();

  await page
    .getByRole("button", { name: /Add account/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "Your company's domain" }).waitFor();
  const google = `gws-${Date.now()}.test`;
  await page.getByLabel("Domain").fill(google);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: `Verify you own ${google}` }).waitFor();

  // And the Omni path still opens its own.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Use Omni instead" }).click();
  const heading = page.getByRole("heading", { name: `Verify you own ${omni}` });
  await heading.waitFor();
  expect(await heading.isVisible()).toBe(true);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
