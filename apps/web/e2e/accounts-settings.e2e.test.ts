import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  sentMail,
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
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("sign-in emails and connected inboxes share one row per address", async () => {
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = "rodrigo@chowmein.test";
  const gmail = "rodrigo.side@gmail.test";
  const org = await createOrgWithOwner(db, {
    name: "Chow Mein",
    slug: "chowmein",
    ownerEmail: email,
  });
  for (const address of [email, gmail]) {
    const box = await createMailbox(db, org.orgId, address, "personal", "gmail");
    await grant(db, org.orgId, box.id, org.memberId);
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
  await page.goto(new URL("/chowmein/settings/accounts", origin).toString());

  await page.getByText("Sign in · Inbox syncing", { exact: true }).waitFor();
  await expect(page.getByText(email, { exact: true }).count()).resolves.toBe(1);
  await page.getByText("Inbox syncing", { exact: true }).waitFor();

  await page.getByRole("button", { name: `Actions for ${gmail}` }).click();
  await page.getByRole("menuitem", { name: "Sign in with it" }).click();
  await expect.poll(async () => (await sentMail(worker, gmail)).length).toBe(1);

  await page.route("https://accounts.google.com/**", (route) => route.abort());
  const consent = page.waitForRequest((request) =>
    request.url().startsWith("https://accounts.google.com/"),
  );
  await page.getByRole("button", { name: "Add an email" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("ana@elsewhere.test");
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Sign in", { exact: true }).click();
  await dialog.getByText("Inbox", { exact: true }).click();
  await dialog.getByRole("button", { name: "Connect" }).click();
  expect(new URL((await consent).url()).searchParams.get("login_hint")).toBe("ana@elsewhere.test");
  expect(await sentMail(worker, "ana@elsewhere.test")).toEqual([]);
  await context.close();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
