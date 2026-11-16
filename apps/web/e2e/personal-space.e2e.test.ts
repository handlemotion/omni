// Personal spaces in the web app (ADR 0024 step 5), in a real Chromium, on the web app built and
// served by the real Worker under `wrangler dev`, on a real Postgres: someone in no company works
// in their Personal space instead of being sent to create one, and its settings leave out the
// pages only a company has.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptJoinRequest, createOrgWithOwner, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
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
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
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

/** Signed in as `email` (a magic link, so a new address signs up), on `path`. */
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

/** The settings nav's workspace pages, by title. */
async function settingsPages(page: Page) {
  const link = (title: string) => page.getByRole("link", { name: title, exact: true });
  await link("Inboxes").waitFor();
  const titles = ["General", "People", "Inboxes", "Shared", "Helpdesk"];
  const shown: string[] = [];
  for (const title of titles) {
    if ((await link(title).count()) > 0) shown.push(title);
  }
  return shown;
}

// Catches: a new person forced through creating a company before they can read their own mail.
test("someone in no company lands in their Personal space's inbox, not in company setup", async () => {
  const page = await signedIn(`solo-${Date.now()}@gmail.test`, "/");
  // The inbox shell's switcher renders only once the member guards let the page stay (a
  // redirect to setup passes through `/inbox` on its way, so the URL alone proves nothing).
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe("/inbox");
});

// Catches: a new Personal space showing an empty list with no way to bring mail in.
test("an empty Personal space offers to connect Google or set up a company", async () => {
  const page = await signedIn(`empty-${Date.now()}@gmail.test`, "/inbox");
  await page.getByText("No accounts yet").waitFor({ timeout: 15_000 });
  // The switcher's All mark keeps its two blank discs with no mailbox to draw them from.
  const trigger = page.getByRole("button", { name: /^Switch mailbox/ });
  expect(await trigger.locator("[data-slot=avatar]").count()).toBe(2);
  // Google is not set up on this install: setting up a company is the one way on.
  expect(await page.getByRole("button", { name: "Connect Google" }).count()).toBe(0);
  await page.getByRole("button", { name: "Set up a company" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding");
});

// Catches: a Personal space offering team, shared-inbox and helpdesk settings it can never use.
test("a Personal space's settings leave out the company pages; a company's keep them", async () => {
  const personal = await signedIn(`me-${Date.now()}@gmail.test`, "/settings");
  expect(await settingsPages(personal)).toEqual(["General", "Inboxes"]);
  await context?.close();

  const email = `owner-${Date.now()}@company.test`;
  await createOrgWithOwner(db, { name: "Acme", slug: `acme-${Date.now()}`, ownerEmail: email });
  const company = await signedIn(email, "/settings");
  expect(await settingsPages(company)).toEqual([
    "General",
    "People",
    "Inboxes",
    "Shared",
    "Helpdesk",
  ]);
});

// Catches: switching settings to the Personal space while on People still rendering People, with
// an invite form the server refuses.
test("switching settings from a company's People page to the Personal space falls back", async () => {
  const email = `switch-${Date.now()}@company.test`;
  await createOrgWithOwner(db, {
    name: "Switch Co",
    slug: `switch-${Date.now()}`,
    ownerEmail: email,
  });
  const page = await signedIn(email, "/settings/people");
  await page.getByRole("heading", { name: "People" }).first().waitFor();

  await page.getByRole("button", { name: /^Switch workspace, currently Switch Co/ }).click();
  await page.getByRole("menuitem", { name: /(?:'s|^Personal) Workspace$/ }).click();
  await page.getByRole("button", { name: /^Switch workspace, currently .*Workspace$/ }).waitFor();
  await page.getByRole("heading", { name: "General" }).first().waitFor();
  expect(await page.getByRole("heading", { name: "People" }).count()).toBe(0);
});

// Catches: compose without `?mailbox=` sending a company's mail from a personal address that
// happens to sort first among every address the person can open.
test("compose defaults to the active workspace's address, and still offers the others", async () => {
  const email = `sender-${Date.now()}@company.test`;
  const org = await createOrgWithOwner(db, {
    name: "Sender Co",
    slug: `sender-${Date.now()}`,
    ownerEmail: email,
  });
  const page = await signedIn(email, "/inbox");
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  const [space] = await db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .where(eq(schema.personalSpaces.userId, user!.id));
  const grant = async (orgId: string, address: string) => {
    const box = await createMailbox(db, orgId, address, "personal");
    const [member] = await db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(and(eq(schema.members.organizationId, orgId), eq(schema.members.userId, user!.id)));
    await db
      .insert(schema.mailboxAccess)
      .values({ orgId, mailboxId: box.id, memberId: member!.id, role: "owner" });
  };
  // The Personal address sorts first.
  await grant(space!.orgId, "aaa@gmail.test");
  await grant(org.orgId, "zzz@company.test");

  await page.goto(new URL("/compose", String(worker.url)).toString());
  // The workspace's address is chosen; the menu still offers the Personal one.
  await page.getByRole("button", { name: "From zzz@company.test" }).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitemradio", { name: "aaa@gmail.test" }).waitFor();
  await expect
    .poll(() => menu.getByRole("menuitemradio", { checked: true }).textContent())
    .toBe("zzz@company.test");
});

// Catches: offering company setup to someone who cannot create one (a sign-in scoped to a
// company), whose button would only bounce them back.
test("the empty state offers company setup only to someone who can create a company", async () => {
  const email = `scoped-${Date.now()}@empty-co.test`;
  const company = await createOrgWithOwner(db, {
    name: "Empty Co",
    slug: `empty-co-${Date.now()}`,
    ownerEmail: email,
  });
  await db
    .insert(schema.mailDomains)
    .values({ orgId: company.orgId, domain: "empty-co.test", provider: "imap" });
  await db
    .insert(schema.orgSetup)
    .values({ orgId: company.orgId, step: "complete" })
    .onConflictDoUpdate({ target: schema.orgSetup.orgId, set: { step: "complete" } });
  const page = await signedIn(email, "/inbox");
  await page.getByText("No accounts yet").waitFor({ timeout: 15_000 });
  expect(await page.getByRole("button", { name: "Set up a company" }).count()).toBe(0);
});

// Catches: a work-address sign-in by someone outside the company bouncing back to sign-in.
test("signing in with a company's address as an outsider opens a join screen to ask", async () => {
  const tag = Date.now();
  const company = await createOrgWithOwner(db, {
    name: "Join Co",
    slug: `join-co-${tag}`,
    ownerEmail: `owner-${tag}@owners.test`,
  });
  await db
    .insert(schema.mailDomains)
    .values({ orgId: company.orgId, domain: `join-${tag}.test`, provider: "imap" });
  const page = await signedIn(`ana@join-${tag}.test`, "/inbox");
  await page.getByRole("heading", { name: "Join Join Co" }).waitFor({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe("/join");
  await page.getByRole("button", { name: "Ask to join" }).click();
  const requested = page.getByRole("button", { name: "Requested" });
  await requested.waitFor();
  expect(await requested.isDisabled()).toBe(true);

  // Accepted: the page notices on its next check and opens the inbox, as the company's member.
  const [request] = await db
    .select({ id: schema.joinRequests.id })
    .from(schema.joinRequests)
    .where(eq(schema.joinRequests.orgId, company.orgId));
  expect(await acceptJoinRequest(db, { orgId: company.orgId, requestId: request!.id })).toEqual(
    expect.any(String),
  );
  await page.waitForURL((url) => url.pathname === "/inbox", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
