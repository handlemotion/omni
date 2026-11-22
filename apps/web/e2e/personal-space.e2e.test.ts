import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { acceptJoinRequest, createOrgWithOwner, ensurePersonalSpace, schema } from "@omni/db";
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

const place = (url: URL | string) => `/${new URL(url).pathname.split("/").slice(2).join("/")}`;

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

async function signedIn(email: string, path: string, { personal = true } = {}) {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  if (personal) {
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    await ensurePersonalSpace(db, user!.id);
  }
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

test("someone in no workspace chooses Just me and lands in their Personal space's inbox", async () => {
  const email = `solo-${Date.now()}@gmail.test`;
  const page = await signedIn(email, "/", { personal: false });
  await page.getByRole("heading", { name: "Welcome to Omni" }).waitFor({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe("/welcome");
  expect(await page.getByRole("button", { name: "Create a workspace" }).count()).toBe(1);
  await page.getByRole("button", { name: "Just me" }).click();
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor({ timeout: 15_000 });
  expect(place(page.url())).toBe("/mail/inbox");
  const spaces = await db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .innerJoin(schema.users, eq(schema.users.id, schema.personalSpaces.userId))
    .where(eq(schema.users.email, email));
  expect(spaces).toHaveLength(1);
});

test("someone with a Personal space from before still lands in its inbox, not in company setup", async () => {
  const page = await signedIn(`before-${Date.now()}@gmail.test`, "/");
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor({ timeout: 15_000 });
  expect(place(page.url())).toBe("/mail/inbox");
});

test("an empty Personal space offers to connect Google or set up a company", async () => {
  const page = await signedIn(`empty-${Date.now()}@gmail.test`, "/inbox");
  await page.getByText("No accounts yet").waitFor({ timeout: 15_000 });
  const trigger = page.getByRole("button", { name: /^Switch mailbox/ });
  expect(await trigger.locator("[data-slot=avatar]").count()).toBe(2);
  expect(await page.getByRole("button", { name: "Connect Google" }).count()).toBe(0);
  await page.getByRole("button", { name: "Set up a company" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding");
});

test("a Personal space's settings have every page a company's has", async () => {
  const personal = await signedIn(`me-${Date.now()}@gmail.test`, "/settings");
  expect(await settingsPages(personal)).toEqual([
    "General",
    "People",
    "Inboxes",
    "Shared",
    "Helpdesk",
  ]);
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

test("switching settings from a company's People page to the Personal space keeps People", async () => {
  const email = `switch-${Date.now()}@company.test`;
  await createOrgWithOwner(db, {
    name: "Switch Co",
    slug: `switch-${Date.now()}`,
    ownerEmail: email,
  });
  const page = await signedIn(email, "/settings/people");
  await page.getByRole("heading", { name: "People" }).first().waitFor();

  const settingsNav = page.locator('[data-slot="sidebar"]');
  await settingsNav.getByRole("button", { name: /^Switch workspace, currently Switch Co/ }).click();
  await page.getByRole("menuitem", { name: /(?:'s|^Personal) Workspace$/ }).click();
  await settingsNav
    .getByRole("button", { name: /^Switch workspace, currently .*Workspace$/ })
    .waitFor();
  await page.getByRole("heading", { name: "People" }).first().waitFor();
  expect(new URL(page.url()).pathname).toMatch(/\/settings\/people$/);
});

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
  await grant(space!.orgId, "aaa@gmail.test");
  await grant(org.orgId, "zzz@company.test");

  await page.goto(new URL("/compose", String(worker.url)).toString());
  await page.getByRole("button", { name: "From zzz@company.test" }).click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitemradio", { name: "aaa@gmail.test" }).waitFor();
  await expect
    .poll(() => menu.getByRole("menuitemradio", { checked: true }).textContent())
    .toBe("zzz@company.test");
});

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

  const [request] = await db
    .select({ id: schema.joinRequests.id })
    .from(schema.joinRequests)
    .where(eq(schema.joinRequests.orgId, company.orgId));
  expect(await acceptJoinRequest(db, { orgId: company.orgId, requestId: request!.id })).toEqual(
    expect.any(String),
  );
  await page.waitForURL((url) => place(url) === "/mail/inbox", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("in a Personal space, Add a shared mailbox asks for a shared inbox, not the owner's own", async () => {
  const email = `shares-${Date.now()}@gmail.test`;
  const page = await signedIn(email, "/settings/shared");
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  const [space] = await db
    .select({ orgId: schema.personalSpaces.orgId })
    .from(schema.personalSpaces)
    .where(eq(schema.personalSpaces.userId, user!.id));
  const now = new Date();
  await db.insert(schema.mailDomains).values({
    orgId: space!.orgId,
    domain: `shares-${Date.now()}.test`,
    provider: "purelymail",
    verifiedAt: now,
    addedAt: now,
  });
  await page.reload();

  await page.getByRole("button", { name: "Add a shared mailbox" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Address" }).fill("hello");
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/(workspace\/shared-inboxes|onboarding\/mailboxes)$/.test(
        new URL(request.url()).pathname,
      ),
  );
  await dialog.getByRole("button", { name: "Add" }).click();
  expect(new URL((await sent).url()).pathname).toBe("/api/workspace/shared-inboxes");
});
