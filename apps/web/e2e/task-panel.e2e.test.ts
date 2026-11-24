import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
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
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, RATE_LIMIT_AUTH: "off" },
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

test("status and priority picked in the panel save, a cancelled task leaves the open list, and changes and comments show in its activity", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "issue-panel");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `issue-panel-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const headers = { cookie, origin, "content-type": "application/json", "omni-workspace": org.id };
  const deal = await fetch(new URL("/api/crm/deals", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Harbor launch" }),
  });
  const dealId = ((await deal.json()) as { deal: { id: string } }).deal.id;
  const made = await fetch(new URL("/api/crm/tasks", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Confirm the venue", dealId }),
  });
  const { task } = (await made.json()) as { task: { id: string } };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/tasks?task=${task.id}`, origin).toString());
  const panel = page.getByRole("region", { name: "Task", exact: true });
  const activity = panel.getByRole("region", { name: "Activity" });
  await expect
    .poll(() => activity.getByText("created the task").isVisible(), { timeout: 10_000 })
    .toBe(true);

  await panel.getByRole("button", { name: "Status: To do" }).click();
  await page.getByRole("menuitemradio", { name: "In progress" }).click();
  await expect.poll(async () => (await row(task.id))?.status ?? null).toBe("in_progress");
  await expect
    .poll(() => activity.getByText("moved from To do to In progress").isVisible())
    .toBe(true);

  await panel.getByRole("button", { name: "Set priority" }).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect.poll(async () => (await row(task.id))?.priority ?? null).toBe("high");
  await expect
    .poll(() => panel.getByRole("button", { name: "Priority: High" }).isVisible())
    .toBe(true);

  await panel.getByRole("textbox", { name: "Comment" }).fill("Parking is on the north side.");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect
    .poll(() => activity.getByText("Parking is on the north side.").isVisible())
    .toBe(true);
  await page.reload();
  await expect
    .poll(() => activity.getByText("Parking is on the north side.").isVisible(), {
      timeout: 10_000,
    })
    .toBe(true);

  await panel.getByRole("button", { name: "Status: In progress" }).click();
  await page.getByRole("menuitemradio", { name: "Cancelled" }).click();
  await expect.poll(async () => (await row(task.id))?.completedAt ?? null).not.toBeNull();
  await fetch(new URL("/api/crm/tasks", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Book the crew", dealId }),
  });
  await page.goto(new URL(`/${org.slug}/crm/tasks?assignee=anyone`, origin).toString());
  await expect
    .poll(() => page.getByRole("link", { name: "Book the crew" }).isVisible(), { timeout: 10_000 })
    .toBe(true);
  expect(await page.getByRole("link", { name: "Confirm the venue" }).count()).toBe(0);
  await context.close();
});

async function row(id: string) {
  const [found] = await db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.id, id));
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
