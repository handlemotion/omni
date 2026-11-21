import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { advanceOrgSetup, createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  CookieJar,
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  invite,
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

const origin = () => String(worker.url);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function invitedTo(name: string, email: string, role: "admin" | "member" = "admin") {
  const ownerEmail = `rosa-${stamp()}@owner.test`;
  const org = await createOrgWithOwner(db, {
    name,
    slug: `co-${stamp()}`,
    ownerEmail,
    ownerName: "Rosa",
  });
  await advanceOrgSetup(db, org.orgId, "complete");
  const shared = await createMailbox(db, org.orgId, `hello-${stamp()}@co.test`);
  await grant(db, org.orgId, shared.id, org.memberId);
  const owner = new CookieJar();
  await signIn({ url: new URL(origin()) }, db, ownerEmail, owner);
  const sent = await invite({ url: new URL(origin()) }, owner, {
    email,
    role,
    sharedInboxIds: [shared.id],
  });
  expect(sent.status).toBe(200);
  const { invitation } = (await sent.json()) as { invitation: { id: string } };
  return { ...org, invitationId: invitation.id };
}

async function signedIn(email: string, path: string) {
  const cookie = await signIn({ url: new URL(origin()) }, db, email);
  context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin() };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(path, origin()).toString());
  return page satisfies Page;
}

test("an invited Gmail user who signs in without the link sees the invitation first and joins", async () => {
  const email = `friend-${stamp()}@gmail.test`;
  const acme = await invitedTo("Acme", email);

  const page = await signedIn(email, "/");
  await page.getByRole("heading", { name: "Your invitations" }).waitFor({ timeout: 15_000 });
  const row = page.getByRole("listitem").filter({ hasText: "Acme" });
  await row.getByText("Rosa · Admin").waitFor();
  expect(await page.getByRole("button", { name: "Create a workspace" }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Just me" }).count()).toBe(1);

  await row.getByRole("button", { name: "Join Acme" }).click();
  await page.waitForURL((url) => url.pathname.startsWith(`/${acme.slug}/`), { timeout: 15_000 });
  const [member] = await db
    .select({ role: schema.members.role })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.users.email, email));
  expect(member?.role).toBe("admin");
  expect(
    await db
      .select({ orgId: schema.personalSpaces.orgId })
      .from(schema.personalSpaces)
      .innerJoin(schema.users, eq(schema.users.id, schema.personalSpaces.userId))
      .where(eq(schema.users.email, email)),
  ).toEqual([]);
});

test("Just me with invitations still waiting opens the new Personal space", async () => {
  const email = `mine-${stamp()}@gmail.test`;
  await invitedTo("Delta", email);
  const page = await signedIn(email, "/");
  await page.getByRole("heading", { name: "Your invitations" }).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Just me" }).click();
  await page.getByRole("button", { name: /^Switch mailbox/ }).waitFor({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toMatch(/^\/personal-[^/]+\/mail\/inbox$/);
  await page.goto(new URL("/", origin()).toString());
  await page.waitForURL((url) => url.pathname.endsWith("/mail/inbox"), { timeout: 15_000 });
});

test("the invite page says who invited whom to what, and declining says so", async () => {
  const email = `link-${stamp()}@gmail.test`;
  const { invitationId } = await invitedTo("Beta", email, "member");
  const page = await signedIn(email, `/invite/${invitationId}`);
  await page
    .getByRole("heading", { name: "Rosa invited you to Beta" })
    .waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Decline" }).click();
  await page.getByRole("heading", { name: "You declined the invitation to Beta" }).waitFor();
  const [row] = await db
    .select({ status: schema.invitations.status })
    .from(schema.invitations)
    .where(eq(schema.invitations.id, invitationId));
  expect(row?.status).toBe("rejected");
});

test("the invite page tells another account, and an expired link, plainly", async () => {
  const email = `owned-${stamp()}@gmail.test`;
  const { invitationId } = await invitedTo("Gamma", email);
  const other = await signedIn(`other-${stamp()}@gmail.test`, `/invite/${invitationId}`);
  await other
    .getByRole("heading", { name: "This invitation is for another email" })
    .waitFor({ timeout: 15_000 });
  expect(await other.getByText("Gamma").count()).toBe(0);
  expect(await other.getByRole("button", { name: "Use another account" }).count()).toBe(1);
  await context?.close();

  await db
    .update(schema.invitations)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.invitations.id, invitationId));
  const late = await signedIn(email, `/invite/${invitationId}`);
  await late
    .getByRole("heading", { name: "Your invitation to Gamma has expired" })
    .waitFor({ timeout: 15_000 });
});

test("a missing invitation says so; one that fails to load offers to try again", async () => {
  const email = `flaky-${stamp()}@gmail.test`;
  const { invitationId } = await invitedTo("Epsilon", email);
  const page = await signedIn(email, `/invite/${crypto.randomUUID()}`);
  await page
    .getByRole("heading", { name: "This invitation doesn't exist" })
    .waitFor({ timeout: 15_000 });

  await page.route(`**/api/invitations/${invitationId}`, (route) => route.abort());
  await page.goto(new URL(`/invite/${invitationId}`, origin()).toString());
  await page.getByRole("heading", { name: "This invitation couldn't load" }).waitFor();
  await page.unroute(`**/api/invitations/${invitationId}`);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "Rosa invited you to Epsilon" }).waitFor();
  expect(await page.getByRole("button", { name: "Join" }).count()).toBe(1);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
