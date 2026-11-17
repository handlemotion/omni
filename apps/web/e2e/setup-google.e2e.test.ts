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

async function signedIn(email: string, path: string) {
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
  return page satisfies Page;
}

const heading = (page: Page, name: string) => page.getByRole("heading", { name }).waitFor();

/** The claims on `domain`, by provider. */
const claims = (domain: string) =>
  db
    .select({ provider: schema.domainClaims.provider, status: schema.domainClaims.status })
    .from(schema.domainClaims)
    .where(eq(schema.domainClaims.domain, domain));

// Catches: setup leaving for Google before the company owns its domain (every account would open
// in its owner's Personal space), Back jumping to a step that wasn't the one before, and a domain
// that can't be changed once entered.
test("setup walks one step list: the domain first, Back one step at a time, the domain editable", async () => {
  const page = await signedIn(`founder-${Date.now()}@gmail.test`, "/onboarding");
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByRole("button", { name: "Continue" }).click();

  // The domain comes before any account; at Google by default where Google is set up.
  await heading(page, "Your company's domain");
  await page.getByText("Google Workspace", { exact: true }).waitFor();
  const first = `acme-${Date.now()}.test`;
  await page.getByRole("textbox", { name: "Domain" }).fill(first);
  await page.getByRole("button", { name: "Continue" }).click();
  await heading(page, `Verify you own ${first}`);
  expect(await claims(first)).toEqual([{ provider: "gmail", status: "pending" }]);

  // Back is the step before, with what was entered: the domain, ready to change.
  await page.getByRole("button", { name: "Back" }).click();
  await heading(page, "Your company's domain");
  expect(await page.getByRole("textbox", { name: "Domain" }).inputValue()).toBe(first);
  const second = `acme-two-${Date.now()}.test`;
  await page.getByRole("textbox", { name: "Domain" }).fill(second);
  await page.getByRole("button", { name: "Continue" }).click();
  await heading(page, `Verify you own ${second}`);
  // The first claim, still waiting for DNS, gave way to the second.
  expect(await claims(first)).toEqual([{ provider: "gmail", status: "released" }]);
  expect(await claims(second)).toEqual([{ provider: "gmail", status: "pending" }]);

  // Back twice is the workspace, never a step out of order.
  await page.getByRole("button", { name: "Back" }).click();
  await heading(page, "Your company's domain");
  await page.getByRole("button", { name: "Back" }).click();
  await heading(page, "Welcome to Omni");
  expect(new URL(page.url()).host).toBe(new URL(String(worker.url)).host);
});

// Catches: switching a domain from Omni to Google leaving setup on the old domain's records.
test("a domain claimed for Omni can be switched to Google from the domain step", async () => {
  const name = `Duo ${Date.now()}`;
  const page = await signedIn(`duo-${Date.now()}@gmail.test`, "/onboarding");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await heading(page, "Your company's domain");
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.name, name));
  const [owner] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(eq(schema.members.organizationId, org!.id));
  const domain = `omni-${Date.now()}.test`;
  await openClaim(db, {
    orgId: org!.id,
    domain,
    memberId: owner!.id,
    challengeHash: "0".repeat(64),
    provider: "imap",
    dnsRecords: [],
  });

  // Setup resumes on that domain's records; Back opens the domain step with it, at Omni.
  await page.reload();
  await heading(page, `Verify you own ${domain}`);
  await page.getByRole("button", { name: "Back" }).click();
  await heading(page, "Your company's domain");
  expect(await page.getByRole("textbox", { name: "Domain" }).inputValue()).toBe(domain);
  await page.getByText("Google Workspace", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await heading(page, `Verify you own ${domain}`);
  // The same domain's claim, now at Google.
  expect(await claims(domain)).toEqual([{ provider: "gmail", status: "pending" }]);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
