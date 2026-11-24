import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createTestDatabase,
  sentMail,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
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
    vars: { BETTER_AUTH_URL: `http://localhost:${port}` },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("a day-old session confirms with an emailed code, then adds a passkey and lists devices", async () => {
  const email = "rodrigo@chowmein.test";
  await createOrgWithOwner(db, { name: "Chow Mein", slug: "chowmein", ownerEmail: email });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  const origin = String(worker.url).replace("127.0.0.1", "localhost");
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  await db
    .update(schema.sessions)
    .set({ createdAt: twoDaysAgo, updatedAt: twoDaysAgo })
    .where(eq(schema.sessions.userId, user!.id));

  const context = await browser.newContext();
  await context.addCookies(
    cookie
      .split("; ")
      .filter((pair) => !pair.includes("session_data"))
      .map((pair) => {
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
      }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(new URL("/chowmein/settings/security", origin).toString());
  await page.getByText("Confirm it's you to see your devices").waitFor();

  const sentBefore = (await sentMail(worker, email)).length;
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.getByRole("dialog", { name: "Confirm it's you" }).waitFor();
  const code = async () => {
    const mail = await sentMail(worker, email);
    return mail.length > sentBefore ? mail.at(-1)?.text.match(/\b(\d{6})\b/)?.[1] : undefined;
  };
  await expect.poll(code).toMatch(/^\d{6}$/);
  const otp = (await code())!;
  await page.getByRole("textbox", { name: "Code" }).fill(otp);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect
    .poll(async () => db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user!.id)))
    .toHaveLength(1);
  await page.getByRole("button", { name: "Actions for Passkey on Linux" }).waitFor();
  await page.getByText("Active now").waitFor();
  const sessions = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, user!.id));
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.createdAt.getTime()).toBeGreaterThan(twoDaysAgo.getTime());
  await context.close();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
