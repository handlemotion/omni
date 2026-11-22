import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
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

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      RATE_LIMIT_AUTH: "off",
      RATE_LIMIT_BOOKING_NEW: "off",
    },
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

async function owner() {
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `rodrigo-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const context = await browser.newContext({
    timezoneId: "Europe/Madrid",
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  return { org, inbox, origin, page: await context.newPage() };
}

test("a link made from Share is booked by a visitor with no account, and the meeting invites them", async () => {
  const { org, inbox, origin, page } = await owner();
  await page.goto(new URL(`/${org.slug}/calendar`, origin).toString());
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Intro call");
  await page.locator("form").getByRole("button", { name: "Create link" }).click();
  const row = page.getByRole("button", { name: "Copy link to Intro call" });
  await row.waitFor();
  const [link] = await db
    .select({ slug: schema.calendarBookingLinks.slug })
    .from(schema.calendarBookingLinks)
    .where(eq(schema.calendarBookingLinks.orgId, org.id));
  expect(await row.textContent()).toContain(`/book/${link!.slug}`);

  const visitor = await browser.newContext({
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 860 },
  });
  const guest = await visitor.newPage();
  await guest.goto(new URL(`/book/${link!.slug}`, origin).toString());
  await guest.getByRole("heading", { name: "Intro call" }).waitFor();
  const times = guest.getByRole("group", { name: "Times" }).getByRole("button");
  const first = (await times.first().textContent()) ?? "";
  await times.first().click();
  await guest.getByRole("textbox", { name: "Name" }).fill("Ana");
  await guest.getByRole("textbox", { name: "Email" }).fill("ana@acme.example");
  await guest.getByRole("button", { name: "Book" }).click();
  await guest.getByText("Booked").waitFor();
  await expect.poll(() => guest.getByText(first.trim()).count()).toBeGreaterThan(0);

  const sends = await db
    .select({ payload: schema.mailActions.payload })
    .from(schema.mailActions)
    .where(and(eq(schema.mailActions.mailboxId, inbox.id), eq(schema.mailActions.kind, "send")));
  expect(sends.map((s) => (s.payload as { to: string[] }).to)).toEqual([["ana@acme.example"]]);
  const [event] = await db
    .select({ title: schema.calendarEvents.title })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.orgId, org.id));
  expect(event?.title).toBe("Intro call (Ana)");
});

test("a link that does not exist shows Not found", async () => {
  const page = await browser.newPage();
  await page.goto(new URL("/book/nope", String(worker.url)).toString());
  await expect.poll(() => page.getByText("Not found").count()).toBe(1);
});
