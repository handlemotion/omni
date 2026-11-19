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
  grant,
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
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, GOOGLE_CLIENT_ID: "e2e-google-client" },
    secrets: { GOOGLE_CLIENT_SECRET: "e2e-google-secret" },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("sign-in addresses and inboxes: a Gmail address is an inbox switched off until turned on", async () => {
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = "rodrigo@chowmein.test";
  const gmail = "rodrigo.side@gmail.com";
  const connected = "connected@gmail.com";
  const org = await createOrgWithOwner(db, {
    name: "Chow Mein",
    slug: "chowmein",
    ownerEmail: email,
  });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  await db
    .insert(schema.userEmails)
    .values({ userId: user!.id, email: gmail, verifiedAt: new Date() });
  const hosted = await createMailbox(db, org.orgId, email, "personal");
  await grant(db, org.orgId, hosted.id, org.memberId);
  const box = await createMailbox(db, org.orgId, connected, "personal", "gmail");
  await db
    .insert(schema.mailboxAccess)
    .values({ orgId: org.orgId, mailboxId: box.id, memberId: org.memberId, role: "owner" });

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
  await page.goto(new URL("/chowmein/settings/accounts", origin).toString());

  const inbox = (address: string) => page.getByRole("switch", { name: address });
  await inbox(connected).waitFor();
  await expect.poll(() => inbox(connected).isChecked()).toBe(true);
  expect(await inbox(gmail).isChecked()).toBe(false);
  expect(await inbox(email).isChecked()).toBe(true);
  expect(await inbox(email).isDisabled()).toBe(true);
  expect(await page.getByText("Primary", { exact: true }).count()).toBe(0);

  await page.getByRole("button", { name: `Inbox actions for ${connected}` }).click();
  await page.getByRole("menuitem", { name: "Add a label" }).click();
  await page.getByRole("textbox", { name: "Label" }).fill("Personal");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => {
      const [row] = await db
        .select({ label: schema.mailboxes.label })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, box.id));
      return row?.label;
    })
    .toBe("Personal");
  await page.getByText("(Personal)").waitFor();
  await page.getByRole("button", { name: `Inbox actions for ${connected}` }).click();
  await page.getByRole("menuitem", { name: "Reconnect" }).waitFor();
  await page.getByRole("menuitem", { name: "Sender name" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Rodrigo @ Chow Mein");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => {
      const [row] = await db
        .select({ senderName: schema.mailboxes.senderName })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, box.id));
      return row?.senderName;
    })
    .toBe("Rodrigo @ Chow Mein");
  await page.getByRole("button", { name: `Inbox actions for ${connected}` }).click();
  await page.getByRole("menuitem", { name: "Remove sender name" }).click();
  await expect
    .poll(async () => {
      const [row] = await db
        .select({ senderName: schema.mailboxes.senderName })
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, box.id));
      return row?.senderName;
    })
    .toBeNull();

  await page.goto(new URL("/compose", origin).toString());
  await page.getByRole("button", { name: /^From / }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(connected) }).click();
  await expect
    .poll(() => page.getByRole("button", { name: `From ${connected}` }).textContent())
    .toBe(connected);
  await page.goto(new URL("/chowmein/settings/accounts", origin).toString());

  await page.getByRole("button", { name: `Actions for ${email}` }).click();
  await page.getByRole("menuitem", { name: "Stop signing in with it" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(async () => {
      const [after] = await db
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, user!.id));
      const extras = await db
        .select({ email: schema.userEmails.email })
        .from(schema.userEmails)
        .where(eq(schema.userEmails.userId, user!.id));
      return { primary: after?.email, extras: extras.map((row) => row.email) };
    })
    .toEqual({ primary: gmail, extras: [] });

  await page.route("https://accounts.google.com/**", (route) => route.abort());
  const consent = page.waitForRequest((request) =>
    request.url().startsWith("https://accounts.google.com/"),
  );
  await page.getByText(gmail, { exact: true }).last().click();
  const asked = new URL((await consent).url()).searchParams;
  expect(asked.get("login_hint")).toBe(gmail);
  expect(asked.get("scope")?.split(" ")).toContain("profile");
  await context.close();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
